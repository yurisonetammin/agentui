import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BridgeContext, BridgeStatePatch } from '../electron/main/rpc/bridge'
import type { RpcObject } from '../electron/main/rpc/chunk-assembly'
import { ClaudeStreamJsonBridge } from '../electron/main/rpc/bridges/claude'
import { CodexAppServerBridge } from '../electron/main/rpc/bridges/codex'
import { isBrowserLikeMcp, parseMcpConfigFiles } from '../electron/main/browser-companion'
import { StateStore } from '../electron/main/store'
import { RuntimeManager } from '../electron/main/rpc/manager'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import type { ThreadStatusUpdate } from '../src/shared/types'
import type { TrustPreset } from '../src/shared/tool-policy'

function makeCtx() {
  const writes: RpcObject[] = []
  const events: RpcObject[] = []
  const responses: { id: string; data: RpcObject | null; error?: string }[] = []
  const states: BridgeStatePatch[] = []
  const ctx: BridgeContext = {
    cwd: process.cwd(),
    sessionPath: null,
    providerId: null,
    modelId: null,
    thinkingLevel: 'medium',
    writeLine: async (line) => { writes.push(JSON.parse(line) as RpcObject) },
    respond: (id, data, error) => { responses.push({ id, data: data ?? null, error }) },
    emit: (event) => { events.push(event) },
    state: (patch) => { states.push(patch) },
  }
  return { ctx, writes, events, responses, states }
}

const info = { cwd: process.cwd(), executablePath: 'fake-cli' }

describe('Claude bridge P1 fixes', () => {
  it('does not emit a second agent_start for steer / follow_up while running', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(info)
    await bridge.initialize(f.ctx)
    await bridge.encodeCommand({ type: 'prompt', id: 'p1', message: 'a' }, f.ctx)
    await bridge.encodeCommand({ type: 'steer', id: 's1', message: 'b' }, f.ctx)
    await bridge.encodeCommand({ type: 'follow_up', id: 'f1', message: 'c' }, f.ctx)
    expect(f.events.filter((e) => e.type === 'agent_start')).toHaveLength(1)
    expect(f.writes).toHaveLength(3)
  })

  it('dismisses the UI card when the CLI cancels an approval', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(info)
    await bridge.initialize(f.ctx)
    bridge.handleFrame({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } }, f.ctx)
    bridge.handleFrame({ type: 'control_cancel_request', request_id: 'r1' }, f.ctx)
    expect(f.events).toContainEqual({ type: 'extension_ui_request', method: 'dismiss', id: 'r1' })
    // Unknown ids produce no dismissal.
    bridge.handleFrame({ type: 'control_cancel_request', request_id: 'nope' }, f.ctx)
    expect(f.events.filter((e) => e.method === 'dismiss')).toHaveLength(1)
  })

  it('rolls back the model when set_model is rejected', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge({ ...info, modelId: 'sonnet' })
    await bridge.initialize(f.ctx)
    await bridge.encodeCommand({ type: 'set_model', id: 'm1', modelId: 'opus' }, f.ctx)
    const requestId = String(f.writes[0].request_id)
    bridge.handleFrame({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'nope' } }, f.ctx)
    expect(f.responses.at(-1)?.error).toBe('nope')
    await bridge.encodeCommand({ type: 'get_state', id: 'g1' }, f.ctx)
    expect((f.responses.at(-1)?.data?.model as RpcObject).id).toBe('sonnet')
  })

  it('compact reports compaction events instead of a second agent_start', async () => {
    const f = makeCtx()
    const bridge = new ClaudeStreamJsonBridge(info)
    await bridge.initialize(f.ctx)
    await bridge.encodeCommand({ type: 'compact', id: 'c1' }, f.ctx)
    bridge.handleFrame({ type: 'result', subtype: 'success' }, f.ctx)
    const types = f.events.map((e) => e.type)
    expect(types).toEqual(['compaction_start', 'compaction_end', 'agent_end'])
  })
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Codex bridge P1 fixes', () => {
  it('emits a single agent_start when turn/started follows the prompt command', async () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge({ ...info, sessionPath: 'codex:th-1' })
    const pending = bridge.encodeCommand({ type: 'prompt', id: 'p1', message: 'x' }, f.ctx)
    await flush()
    bridge.handleFrame({ jsonrpc: '2.0', method: 'turn/started', params: {} }, f.ctx)
    expect(f.events.filter((e) => e.type === 'agent_start')).toHaveLength(1)
    const turnReq = f.writes.find((w) => w.method === 'turn/start')
    bridge.handleFrame({ jsonrpc: '2.0', id: turnReq?.id, result: {} }, f.ctx)
    await pending
    // A server-initiated turn (no prompt command) still emits agent_start.
    bridge.handleFrame({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }, f.ctx)
    bridge.handleFrame({ jsonrpc: '2.0', method: 'turn/started', params: {} }, f.ctx)
    expect(f.events.filter((e) => e.type === 'agent_start')).toHaveLength(2)
  })

  it('dismisses stale approvals on serverRequest/resolved and turn/completed', () => {
    const f = makeCtx()
    const bridge = new CodexAppServerBridge(info)
    bridge.handleFrame(
      { jsonrpc: '2.0', id: 5, method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } },
      f.ctx,
    )
    bridge.handleFrame(
      { jsonrpc: '2.0', id: 6, method: 'item/fileChange/requestApproval', params: { changes: { 'a.ts': {} } } },
      f.ctx,
    )
    bridge.handleFrame({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { id: 5 } }, f.ctx)
    expect(f.events).toContainEqual({ type: 'extension_ui_request', method: 'dismiss', id: '5' })
    // Answering a resolved approval must not write a duplicate JSON-RPC response.
    const writesBefore = f.writes.length
    bridge.handleUiResponse({ id: '5', confirmed: true }, f.ctx)
    expect(f.writes.length).toBe(writesBefore)
    // Turn end drops whatever is still pending (e.g. after an interrupt).
    bridge.handleFrame({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }, f.ctx)
    expect(f.events).toContainEqual({ type: 'extension_ui_request', method: 'dismiss', id: '6' })
  })

  it('aligns the Codex sandbox with the project trust preset, read per turn', async () => {
    const f = makeCtx()
    let preset: TrustPreset = 'readonly'
    const bridge = new CodexAppServerBridge({ ...info, getTrustPreset: () => preset })
    const init = bridge.initialize(f.ctx)
    await flush()
    const initReq = f.writes.find((w) => w.method === 'initialize')
    bridge.handleFrame({ jsonrpc: '2.0', id: initReq?.id, result: {} }, f.ctx)
    await flush()
    const startReq = f.writes.find((w) => w.method === 'thread/start')
    expect((startReq?.params as RpcObject).sandbox).toBe('read-only')
    expect((startReq?.params as RpcObject).approvalPolicy).toBe('on-request')
    bridge.handleFrame({ jsonrpc: '2.0', id: startReq?.id, result: { thread: { id: 'th-9' } } }, f.ctx)
    await init

    const runTurn = async (id: string) => {
      const pending = bridge.encodeCommand({ type: 'prompt', id, message: 'x' }, f.ctx)
      await flush()
      const turnReq = f.writes.filter((w) => w.method === 'turn/start').at(-1)
      bridge.handleFrame({ jsonrpc: '2.0', id: turnReq?.id, result: {} }, f.ctx)
      await pending
      bridge.handleFrame({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }, f.ctx)
      return turnReq?.params as RpcObject
    }
    const readonlyTurn = await runTurn('t1')
    expect(readonlyTurn.sandboxPolicy).toEqual({ type: 'readOnly' })
    // Preset changes apply on the next turn without restarting the process.
    preset = 'auto'
    const autoTurn = await runTurn('t2')
    expect(autoTurn.sandboxPolicy).toEqual({ type: 'workspaceWrite' })
  })
})

describe('RuntimeManager setModel rollback', () => {
  function makeManager(sendCommand: (cmd: RpcObject) => Promise<RpcObject>) {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-p1-model-'))
    const store = new StateStore(join(dir, 'state.json'))
    store.mutate((draft) => {
      draft.projects.push({ id: 'p1', name: 'demo', path: dir, addedAt: Date.now(), defaultHarness: 'claude' })
      draft.threads.push({
        id: 'th-1',
        projectId: 'p1',
        title: 't',
        harness: 'claude',
        cwd: dir,
        thinkingLevel: 'medium',
        modelProvider: 'anthropic',
        modelId: 'sonnet',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'idle',
      })
    })
    const statuses: ThreadStatusUpdate[] = []
    const discovery = { snapshot: () => ({}), refresh: async () => ({}) } as unknown as HarnessDiscoveryService
    const manager = new RuntimeManager(store, discovery, {
      onThreadEvent: () => {},
      onThreadStatus: (s) => statuses.push(s),
      onExtensionUiRequest: () => {},
    })
    ;(manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set('th-1', {
      alive: true,
      sendCommand,
      streaming: false,
    })
    return { manager, store, statuses, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('restores the persisted model when the engine rejects the switch', async () => {
    const h = makeManager(async () => {
      throw new Error('Claude Code 控制请求失败')
    })
    try {
      await expect(h.manager.setModel('th-1', 'anthropic', 'opus')).rejects.toThrow('控制请求失败')
      const thread = h.store.snapshot().threads.find((t) => t.id === 'th-1')
      expect(thread?.modelId).toBe('sonnet')
      expect(thread?.modelProvider).toBe('anthropic')
      expect(h.statuses.at(-1)).toMatchObject({ modelId: 'sonnet', status: 'idle' })
    } finally {
      h.cleanup()
    }
  })

  it('keeps the new model when the switch succeeds', async () => {
    const h = makeManager(async () => ({ type: 'response', success: true }))
    try {
      await h.manager.setModel('th-1', 'anthropic', 'opus')
      expect(h.store.snapshot().threads.find((t) => t.id === 'th-1')?.modelId).toBe('opus')
    } finally {
      h.cleanup()
    }
  })
})

describe('MCP TOML parsing', () => {
  it('handles multi-line args, single quotes and sub-tables', () => {
    const toml = [
      "[mcp_servers.playwright]",
      "command = 'npx'",
      'args = [',
      '  "-y",',
      '  "@playwright/mcp@latest", # trailing comment',
      ']',
      '',
      '[mcp_servers.playwright.env]',
      'DEBUG = "1"',
      '',
      '[mcp_servers."my docs"]',
      'url = "https://example.com/mcp"',
      '',
      '[profiles.default]',
      'model = "x"',
    ].join('\n')
    const servers = parseMcpConfigFiles([{ source: 'codex', kind: 'toml', content: toml }])
    expect(servers).toHaveLength(2)
    expect(servers[0]).toMatchObject({ name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], browserLike: true })
    expect(servers[1]).toMatchObject({ name: 'my docs', url: 'https://example.com/mcp', browserLike: false })
  })

  it('does not match "ego" inside unrelated words', () => {
    expect(isBrowserLikeMcp({ name: 'category-tools', command: 'node' })).toBe(false)
    expect(isBrowserLikeMcp({ name: 'ego-browser', command: 'ego' })).toBe(true)
  })

  it('keeps same-name servers with different args and filters foreign claude projects', () => {
    const json = JSON.stringify({
      projects: {
        'C:\\work\\mine': { mcpServers: { a: { command: 'npx', args: ['x'] } } },
        'C:\\other\\thing': { mcpServers: { b: { command: 'npx', args: ['y'] } } },
      },
      mcpServers: { a: { command: 'npx', args: ['z'] } },
    })
    const all = parseMcpConfigFiles([{ source: 'c', kind: 'json', content: json }])
    expect(all.map((s) => s.name + ':' + (s.args ?? []).join())).toEqual(['a:z', 'a:x', 'b:y'])
    const mine = parseMcpConfigFiles([{ source: 'c', kind: 'json', content: json }], ['c:/work/mine'])
    expect(mine.map((s) => s.name)).toEqual(['a', 'a'])
  })
})
