import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_LABELS, HARNESS_CAPABILITIES } from '../src/shared/capabilities'
import { HARNESS_IDS } from '../src/shared/types'
import type { BridgeContext, BridgeStatePatch } from '../electron/main/rpc/bridge'
import type { RpcObject } from '../electron/main/rpc/chunk-assembly'
import { ClaudeStreamJsonBridge, sessionIdFromPath } from '../electron/main/rpc/bridges/claude'
import { CodexAppServerBridge, codexThreadIdFromSessionPath } from '../electron/main/rpc/bridges/codex'
import { AcpBridge, acpSessionIdFromPath } from '../electron/main/rpc/bridges/acp'

interface FakeCtx {
  ctx: BridgeContext
  writes: RpcObject[]
  events: RpcObject[]
  responses: { id: string; data: RpcObject | null; error?: string }[]
  states: BridgeStatePatch[]
}

function makeCtx(cwd = process.cwd()): FakeCtx {
  const writes: RpcObject[] = []
  const events: RpcObject[] = []
  const responses: FakeCtx['responses'] = []
  const states: BridgeStatePatch[] = []
  const ctx: BridgeContext = {
    cwd,
    sessionPath: null,
    providerId: null,
    modelId: null,
    thinkingLevel: 'medium',
    writeLine: async (line) => {
      writes.push(JSON.parse(line) as RpcObject)
    },
    respond: (id, data, error) => {
      responses.push({ id, data: data ?? null, error })
    },
    emit: (event) => {
      events.push(event)
    },
    state: (patch) => {
      states.push(patch)
    },
  }
  return { ctx, writes, events, responses, states }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await flush()
  }
}

function startInfo(cwd = process.cwd()) {
  return { cwd, executablePath: 'fake-cli' }
}

describe('capability matrix', () => {
  it('defines every capability for every harness', () => {
    for (const id of HARNESS_IDS) {
      const caps = HARNESS_CAPABILITIES[id]
      expect(caps).toBeTruthy()
      for (const { key } of CAPABILITY_LABELS) {
        expect(['yes', 'partial', 'no']).toContain(caps[key])
      }
    }
  })
})

describe('ClaudeStreamJsonBridge', () => {
  it('extracts session ids from jsonl paths', () => {
    expect(sessionIdFromPath('C:\\x\\abc-123.jsonl')).toBe('abc-123')
    expect(sessionIdFromPath(null)).toBeNull()
  })

  it('captures the session id from SessionStart hook frames before init', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    bridge.handleFrame({ type: 'system', subtype: 'hook_started', session_id: 'sess-hook' }, f.ctx)
    const state = f.states.find((s) => s.sessionFile)
    expect(String(state?.sessionFile)).toContain('sess-hook.jsonl')
    await bridge.encodeCommand({ type: 'get_state', id: 'g1' }, f.ctx)
    expect(String(f.responses.at(-1)?.data?.sessionFile)).toContain('sess-hook.jsonl')
  })

  it('prompt writes a stream-json user frame, emits agent_start and responds immediately', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    await bridge.encodeCommand({ type: 'prompt', id: 'p1', message: '你好' }, f.ctx)
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
    })
    expect(f.events.some((e) => e.type === 'agent_start')).toBe(true)
    expect(f.responses).toEqual([{ id: 'p1', data: {} }])
  })

  it('translates stream_event deltas into canonical message_update events', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    bridge.handleFrame(
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } } },
      f.ctx,
    )
    bridge.handleFrame(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } } },
      f.ctx,
    )
    bridge.handleFrame(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"ls"}' } } },
      f.ctx,
    )
    bridge.handleFrame({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }, f.ctx)
    bridge.handleFrame(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } } },
      f.ctx,
    )
    const updates = f.events.filter((e) => e.type === 'message_update').map((e) => e.assistantMessageEvent as RpcObject)
    expect(updates[0]).toMatchObject({ type: 'toolcall_start', id: 'tu1', toolName: 'Bash' })
    expect(updates[1]).toMatchObject({ type: 'toolcall_delta', id: 'tu1', delta: '{"command":' })
    expect(updates[3]).toMatchObject({
      type: 'toolcall_end',
      id: 'tu1',
      toolCall: { id: 'tu1', name: 'Bash', arguments: { command: 'ls' } },
    })
    expect(updates[4]).toMatchObject({ type: 'text_delta', delta: 'hi' })
  })

  it('assistant frame yields canonical message_end content and tool_execution_start', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    bridge.handleFrame(
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
          content: [
            { type: 'thinking', thinking: '想一想' },
            { type: 'text', text: '执行中' },
            { type: 'tool_use', id: 'tu9', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      },
      f.ctx,
    )
    const start = f.events.find((e) => e.type === 'tool_execution_start')
    expect(start).toMatchObject({ toolCallId: 'tu9', toolName: 'Read', args: { file_path: 'a.ts' } })
    const end = f.events.find((e) => e.type === 'message_end')
    const message = end?.message as RpcObject
    expect(message.content).toEqual([
      { type: 'thinking', thinking: '想一想' },
      { type: 'text', text: '执行中' },
      { type: 'toolCall', id: 'tu9', name: 'Read', arguments: { file_path: 'a.ts' } },
    ])
    expect(message.usage).toEqual({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 })
  })

  it('user tool_result frames become tool_execution_end with the registered tool name', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    bridge.handleFrame(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }] } },
      f.ctx,
    )
    bridge.handleFrame(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }] } },
      f.ctx,
    )
    const end = f.events.find((e) => e.type === 'tool_execution_end')
    expect(end).toMatchObject({ toolCallId: 'tu2', toolName: 'Bash', isError: true, result: { content: 'boom' } })
  })

  it('result frame ends the turn and reports context usage', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    await bridge.encodeCommand({ type: 'prompt', id: 'p1', message: 'x' }, f.ctx)
    bridge.handleFrame(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      },
      f.ctx,
    )
    expect(f.events.some((e) => e.type === 'agent_end')).toBe(true)
    const usageState = f.states.find((s) => s.contextUsage)
    expect(usageState?.contextUsage).toMatchObject({ tokens: 160, contextWindow: 200_000 })
    await bridge.encodeCommand({ type: 'get_session_stats', id: 's1' }, f.ctx)
    expect(f.responses.at(-1)?.data?.contextUsage).toMatchObject({ tokens: 160 })
  })

  it('error result frames surface an error event', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    bridge.handleFrame({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '炸了' }, f.ctx)
    const err = f.events.find((e) => e.type === 'error')
    expect(String(err?.error)).toContain('炸了')
    expect(f.events.some((e) => e.type === 'agent_end')).toBe(true)
  })

  it('can_use_tool approval round-trips allow with updatedInput', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    bridge.handleFrame(
      {
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } },
      },
      f.ctx,
    )
    const ui = f.events.find((e) => e.type === 'extension_ui_request')
    expect(ui).toMatchObject({ id: 'req-1', method: 'confirm', title: 'Claude 请求执行 Bash' })
    bridge.handleUiResponse({ id: 'req-1', confirmed: true }, f.ctx)
    await flush()
    const answer = f.writes.find((w) => w.type === 'control_response')
    expect(answer).toMatchObject({
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'rm -rf x' } } },
    })
  })

  it('denied approvals send behavior deny', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    bridge.handleFrame(
      { type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } },
      f.ctx,
    )
    bridge.handleUiResponse({ id: 'req-2', confirmed: false }, f.ctx)
    await flush()
    const answer = f.writes.find((w) => w.type === 'control_response')
    expect((answer?.response as RpcObject)?.response).toMatchObject({ behavior: 'deny' })
  })

  it('abort sends an interrupt control_request and resolves on control_response', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.initialize(f.ctx)
    await bridge.encodeCommand({ type: 'prompt', id: 'p1', message: 'x' }, f.ctx)
    await bridge.encodeCommand({ type: 'abort', id: 'a1' }, f.ctx)
    const ctl = f.writes.find((w) => w.type === 'control_request')
    expect(ctl?.request).toEqual({ subtype: 'interrupt' })
    expect(f.responses.some((r) => r.id === 'a1')).toBe(false)
    bridge.handleFrame(
      { type: 'control_response', response: { subtype: 'success', request_id: ctl?.request_id } },
      f.ctx,
    )
    expect(f.responses.some((r) => r.id === 'a1' && !r.error)).toBe(true)
  })

  it('fork commands are rejected with a friendly error', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(startInfo())
    await bridge.encodeCommand({ type: 'fork', id: 'f1' }, f.ctx)
    expect(f.responses[0]?.error).toContain('不支持')
  })
})

describe('CodexAppServerBridge', () => {
  it('extracts thread ids from codex: session paths', () => {
    expect(codexThreadIdFromSessionPath('codex:th-1')).toBe('th-1')
    expect(codexThreadIdFromSessionPath('acp:th-1')).toBeNull()
  })

  it('maps turn notifications and agent message deltas to canonical events', () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge(startInfo())
    bridge.handleFrame({ jsonrpc: '2.0', method: 'turn/started', params: {} }, f.ctx)
    bridge.handleFrame({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: '你好' } }, f.ctx)
    bridge.handleFrame(
      { jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'agentMessage', id: 'i1', text: '你好世界' } } },
      f.ctx,
    )
    bridge.handleFrame({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }, f.ctx)
    expect(f.events.map((e) => e.type)).toEqual(['agent_start', 'message_update', 'message_end', 'agent_end'])
    const end = f.events[2]?.message as RpcObject
    expect(end.content).toEqual([{ type: 'text', text: '你好世界' }])
  })

  it('accumulates command output deltas and finishes with aggregated output', () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge(startInfo())
    bridge.handleFrame(
      { jsonrpc: '2.0', method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '.' } } },
      f.ctx,
    )
    bridge.handleFrame({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { itemId: 'c1', delta: 'a\n' } }, f.ctx)
    bridge.handleFrame({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { itemId: 'c1', delta: 'b\n' } }, f.ctx)
    bridge.handleFrame(
      { jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls', exitCode: 0, aggregatedOutput: 'a\nb\n' } } },
      f.ctx,
    )
    const start = f.events.find((e) => e.type === 'tool_execution_start')
    expect(start).toMatchObject({ toolCallId: 'c1', toolName: 'shell', args: { command: 'ls' } })
    const update = f.events.filter((e) => e.type === 'tool_execution_update').at(-1)
    expect(update?.partialResult).toEqual({ output: 'a\nb\n' })
    const end = f.events.find((e) => e.type === 'tool_execution_end')
    expect(end).toMatchObject({ toolCallId: 'c1', isError: false, result: { output: 'a\nb\n' } })
  })

  it('failed command exit codes mark tool_execution_end as error', () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge(startInfo())
    bridge.handleFrame(
      { jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c2', command: 'false', exitCode: 1 } } },
      f.ctx,
    )
    const end = f.events.find((e) => e.type === 'tool_execution_end')
    expect(end?.isError).toBe(true)
  })

  it('command approval requests round-trip accept decisions', async () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge(startInfo())
    bridge.handleFrame(
      { jsonrpc: '2.0', id: 5, method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: '需要运行测试' } },
      f.ctx,
    )
    const ui = f.events.find((e) => e.type === 'extension_ui_request')
    expect(ui).toMatchObject({ id: '5', method: 'confirm', title: 'Codex 请求执行命令' })
    expect(String(ui?.message)).toContain('npm test')
    bridge.handleUiResponse({ id: '5', confirmed: true }, f.ctx)
    await flush()
    expect(f.writes).toContainEqual({ jsonrpc: '2.0', id: 5, result: { decision: 'accept' } })
  })

  it('failed turns emit an error before agent_end', () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge(startInfo())
    bridge.handleFrame(
      { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'failed', error: { message: '模型超时' } } } },
      f.ctx,
    )
    expect(f.events.map((e) => e.type)).toEqual(['error', 'agent_end'])
    expect(String(f.events[0]?.error)).toContain('模型超时')
  })

  it('token usage notifications update context stats', () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge(startInfo())
    bridge.handleFrame(
      {
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { last: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200 }, modelContextWindow: 272_000 } },
      },
      f.ctx,
    )
    const usage = f.states.find((s) => s.contextUsage)?.contextUsage
    expect(usage).toMatchObject({ tokens: 1700, contextWindow: 272_000 })
  })
})

describe('AcpBridge', () => {
  const options = { sessionPrefix: 'acp:', engineLabel: 'ACP Agent' }

  async function initializedBridge(f: FakeCtx, agentCapabilities: RpcObject = {}) {
    const bridge = new AcpBridge(startInfo(f.ctx.cwd), options)
    const initPromise = bridge.initialize(f.ctx)
    const initReq = f.writes[0]
    expect(initReq?.method).toBe('initialize')
    bridge.handleFrame({ jsonrpc: '2.0', id: initReq?.id, result: { protocolVersion: 1, agentCapabilities } }, f.ctx)
    await flush()
    const newReq = f.writes.find((w) => w.method === 'session/new')
    expect(newReq).toBeTruthy()
    bridge.handleFrame(
      { jsonrpc: '2.0', id: newReq?.id, result: { sessionId: 's-1', models: { currentModelId: 'm-1', availableModels: [{ modelId: 'm-1', name: 'Model 1' }] } } },
      f.ctx,
    )
    await initPromise
    return bridge
  }

  it('extracts session ids only for the matching prefix', () => {
    expect(acpSessionIdFromPath('acp:s1', 'acp:')).toBe('s1')
    expect(acpSessionIdFromPath('dsh:s1', 'acp:')).toBeNull()
  })

  it('initialize performs the ACP handshake and records the session path', async () => {
    const f = makeCtx()
    await initializedBridge(f)
    const state = f.states.find((s) => s.sessionFile)
    expect(state).toMatchObject({ sessionFile: 'acp:s-1', modelId: 'm-1' })
  })

  it('prompt responds immediately and emits agent_end when session/prompt resolves', async () => {
    const f = makeCtx()
    const bridge = await initializedBridge(f)
    await bridge.encodeCommand({ type: 'prompt', id: 'p1', message: '你好' }, f.ctx)
    expect(f.responses).toContainEqual({ id: 'p1', data: {} })
    expect(f.events.some((e) => e.type === 'agent_start')).toBe(true)
    const promptReq = f.writes.find((w) => w.method === 'session/prompt')
    expect(promptReq?.params).toMatchObject({ sessionId: 's-1', prompt: [{ type: 'text', text: '你好' }] })
    expect(f.events.some((e) => e.type === 'agent_end')).toBe(false)
    bridge.handleFrame({ jsonrpc: '2.0', id: promptReq?.id, result: { stopReason: 'end_turn' } }, f.ctx)
    await flush()
    const end = f.events.find((e) => e.type === 'agent_end')
    expect(end?.stopReason).toBe('end_turn')
  })

  it('maps session/update chunks and tool calls to canonical events', async () => {
    const f = makeCtx()
    const bridge = await initializedBridge(f)
    const update = (u: RpcObject) =>
      bridge.handleFrame({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: u } }, f.ctx)
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '部分回复' } })
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考' } })
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '读取文件', kind: 'read', rawInput: { path: 'a.ts' } })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', title: '读取文件', content: [{ type: 'content', content: { type: 'text', text: '文件内容' } }] })
    const textDelta = f.events.find((e) => (e.assistantMessageEvent as RpcObject | undefined)?.type === 'text_delta')
    expect((textDelta?.assistantMessageEvent as RpcObject)?.delta).toBe('部分回复')
    const thinkDelta = f.events.find((e) => (e.assistantMessageEvent as RpcObject | undefined)?.type === 'thinking_delta')
    expect((thinkDelta?.assistantMessageEvent as RpcObject)?.delta).toBe('思考')
    const start = f.events.find((e) => e.type === 'tool_execution_start')
    expect(start).toMatchObject({ toolCallId: 't1', toolName: '读取文件', args: { path: 'a.ts' } })
    const end = f.events.find((e) => e.type === 'tool_execution_end')
    expect(end).toMatchObject({ toolCallId: 't1', isError: false, result: { output: '文件内容' } })
  })

  it('permission requests round-trip the selected option id', async () => {
    const f = makeCtx()
    const bridge = await initializedBridge(f)
    bridge.handleFrame(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: {
          sessionId: 's-1',
          toolCall: { title: '执行命令' },
          options: [
            { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
            { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
          ],
        },
      },
      f.ctx,
    )
    const ui = f.events.find((e) => e.type === 'extension_ui_request')
    expect(ui).toMatchObject({ id: '7', method: 'select', options: ['允许一次', '拒绝'] })
    bridge.handleUiResponse({ id: '7', value: '允许一次' }, f.ctx)
    await flush()
    expect(f.writes).toContainEqual({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  })

  it('cancelled permissions answer with outcome cancelled', async () => {
    const f = makeCtx()
    const bridge = await initializedBridge(f)
    bridge.handleFrame(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'ok', name: 'OK' }] },
      },
      f.ctx,
    )
    bridge.handleUiResponse({ id: '8', cancelled: true }, f.ctx)
    await flush()
    expect(f.writes).toContainEqual({ jsonrpc: '2.0', id: 8, result: { outcome: { outcome: 'cancelled' } } })
  })

  it('fs/read_text_file serves workspace files and rejects traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-acp-fs-'))
    writeFileSync(join(dir, 'a.txt'), 'line1\nline2\nline3\n', 'utf8')
    const f = makeCtx(dir)
    const bridge = await initializedBridge(f)
    bridge.handleFrame(
      { jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: { path: join(dir, 'a.txt'), line: 2, limit: 1 } },
      f.ctx,
    )
    await waitFor(() => f.writes.some((w) => w.id === 9))
    expect(f.writes).toContainEqual({ jsonrpc: '2.0', id: 9, result: { content: 'line2' } })
    bridge.handleFrame(
      { jsonrpc: '2.0', id: 10, method: 'fs/read_text_file', params: { path: join(dir, '..', 'outside.txt') } },
      f.ctx,
    )
    await waitFor(() => f.writes.some((w) => w.id === 10))
    const denied = f.writes.find((w) => w.id === 10)
    expect((denied?.error as RpcObject)?.code).toBe(-32602)
  })

  it('fs/write_text_file is always refused (read-only client)', async () => {
    const f = makeCtx()
    const bridge = await initializedBridge(f)
    bridge.handleFrame(
      { jsonrpc: '2.0', id: 11, method: 'fs/write_text_file', params: { path: join(f.ctx.cwd, 'x.txt'), content: 'x' } },
      f.ctx,
    )
    await flush()
    const denied = f.writes.find((w) => w.id === 11)
    expect((denied?.error as RpcObject)?.code).toBe(-32603)
  })

  it('unsupported canonical commands respond with an error', async () => {
    const f = makeCtx()
    const bridge = await initializedBridge(f)
    await bridge.encodeCommand({ type: 'compact', id: 'c1' }, f.ctx)
    expect(f.responses.at(-1)?.error).toContain('不支持')
  })
})