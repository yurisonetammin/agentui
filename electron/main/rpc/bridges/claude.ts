import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ExtensionUiResponse, ThinkingLevel } from '@shared/types'
import type { RpcObject } from '../chunk-assembly'
import {
  asString,
  isRecord,
  notify,
  unsupported,
  writeJson,
  type BridgeContext,
  type BridgeStartInfo,
  type ProtocolBridge,
} from '../bridge'

export const CLAUDE_THINKING_TOKENS: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 20480,
  xhigh: 32000,
  max: 63999,
}

/** Claude Code stores sessions under ~/.claude/projects/<escaped-cwd>/<session-id>.jsonl */
export function claudeSessionFilePath(cwd: string, sessionId: string): string {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const expected = join(projectsRoot, slug, `${sessionId}.jsonl`)
  if (existsSync(expected)) return expected
  try {
    for (const dir of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const candidate = join(projectsRoot, dir.name, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // projects dir may not exist yet
  }
  return expected
}

export function sessionIdFromPath(sessionPath: string | null | undefined): string | null {
  if (!sessionPath) return null
  const base = basename(sessionPath)
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base
}

interface StreamBlock {
  type: 'text' | 'thinking' | 'tool_use'
  id?: string
  name?: string
  argsJson: string
}

interface PendingApproval {
  toolName: string
  input: RpcObject
}

function mapUsage(raw: unknown): RpcObject | undefined {
  if (!isRecord(raw)) return undefined
  const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0
  const output = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0
  const cacheRead = typeof raw.cache_read_input_tokens === 'number' ? raw.cache_read_input_tokens : 0
  const cacheWrite = typeof raw.cache_creation_input_tokens === 'number' ? raw.cache_creation_input_tokens : 0
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite }
}

/** Convert Anthropic content blocks into the canonical message_end content shape. */
function canonicalContent(content: unknown): RpcObject[] {
  if (!Array.isArray(content)) return []
  const out: RpcObject[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      out.push({ type: 'thinking', thinking: block.thinking })
    } else if (block.type === 'tool_use' && typeof block.id === 'string') {
      out.push({
        type: 'toolCall',
        id: block.id,
        name: asString(block.name) ?? 'tool',
        arguments: isRecord(block.input) ? block.input : {},
      })
    }
  }
  return out
}

export class ClaudeStreamJsonBridge implements ProtocolBridge {
  private sessionId: string | null = null
  private sessionFile: string | null = null
  private currentModel: string | null = null
  private thinkingLevel: ThinkingLevel
  private streaming = false
  private readonly blocks = new Map<number, StreamBlock>()
  private readonly toolNames = new Map<string, string>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly controlRequests = new Map<string, string>()
  private controlSeq = 0
  private lastContextTokens: number | null = null

  constructor(private readonly info: BridgeStartInfo) {
    this.thinkingLevel = info.thinkingLevel ?? 'medium'
    this.currentModel = info.modelId ?? null
    this.sessionId = sessionIdFromPath(info.sessionPath)
  }

  async initialize(ctx: BridgeContext): Promise<void> {
    // Claude Code emits `system/init` only after the first user message;
    // SessionStart hook frames may carry the session_id earlier. Nothing to send.
    if (this.sessionId) {
      this.sessionFile = claudeSessionFilePath(ctx.cwd, this.sessionId)
    }
  }

  async encodeCommand(command: RpcObject, ctx: BridgeContext): Promise<void> {
    const id = asString(command.id) ?? ''
    const type = asString(command.type) ?? ''
    switch (type) {
      case 'prompt':
      case 'steer':
      case 'follow_up': {
        await this.writeUserMessage(command, ctx)
        this.streaming = true
        ctx.emit({ type: 'agent_start' })
        ctx.respond(id, {})
        return
      }
      case 'abort': {
        if (!this.streaming) {
          ctx.respond(id, {})
          return
        }
        const requestId = `agentui-ctl-${++this.controlSeq}`
        this.controlRequests.set(requestId, id)
        await writeJson(ctx, {
          type: 'control_request',
          request_id: requestId,
          request: { subtype: 'interrupt' },
        })
        return
      }
      case 'set_model': {
        const model = asString(command.modelId)
        if (!model) {
          ctx.respond(id, null, '缺少 modelId')
          return
        }
        const requestId = `agentui-ctl-${++this.controlSeq}`
        this.controlRequests.set(requestId, id)
        this.currentModel = model
        await writeJson(ctx, {
          type: 'control_request',
          request_id: requestId,
          request: { subtype: 'set_model', model },
        })
        return
      }
      case 'set_thinking_level': {
        const level = asString(command.level) as ThinkingLevel | undefined
        if (level) this.thinkingLevel = level
        ctx.respond(id, {})
        notify(ctx, 'Claude Code 的 Thinking 档位通过环境变量生效，将在重新连接后应用。')
        return
      }
      case 'compact': {
        this.streaming = true
        ctx.emit({ type: 'agent_start' })
        await writeJson(ctx, {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
        })
        ctx.respond(id, {})
        return
      }
      case 'get_state': {
        ctx.respond(id, {
          isStreaming: this.streaming,
          isCompacting: false,
          sessionFile: this.sessionFile,
          model: this.currentModel ? { provider: 'anthropic', id: this.currentModel } : null,
          thinkingLevel: this.thinkingLevel,
        })
        return
      }
      case 'get_session_stats': {
        ctx.respond(id, {
          contextUsage:
            this.lastContextTokens !== null
              ? {
                  tokens: this.lastContextTokens,
                  contextWindow: this.contextWindow(),
                  percent: Math.min(100, Math.round((this.lastContextTokens / this.contextWindow()) * 1000) / 10),
                }
              : null,
        })
        return
      }
      case 'get_commands': {
        ctx.respond(id, {
          commands: [
            { name: 'compact', description: '压缩上下文', source: 'prompt' },
            { name: 'cost', description: '查看本次会话费用', source: 'prompt' },
            { name: 'model', description: '切换模型', source: 'prompt' },
          ],
        })
        return
      }
      case 'fork':
      case 'branch':
      case 'clone':
      case 'get_fork_messages': {
        unsupported(ctx, id, '分叉 / 分支树')
        return
      }
      default: {
        unsupported(ctx, id, `命令 ${type}`)
      }
    }
  }

  handleFrame(raw: unknown, ctx: BridgeContext): void {
    if (!isRecord(raw)) return
    const type = asString(raw.type)
    if (!type) return

    if (type === 'system') {
      // Any system frame (init or SessionStart hooks) may carry the session id.
      const sid = asString(raw.session_id)
      if (sid && sid !== this.sessionId) {
        this.sessionId = sid
        this.sessionFile = claudeSessionFilePath(ctx.cwd, sid)
        ctx.state({ sessionFile: this.sessionFile })
      }
      if (raw.subtype === 'init') {
        this.currentModel = asString(raw.model) ?? this.currentModel
        ctx.state({
          sessionFile: this.sessionFile,
          modelProvider: 'anthropic',
          modelId: this.currentModel,
        })
      }
      return
    }

    if (type === 'stream_event') {
      this.handleStreamEvent(raw.event, ctx)
      return
    }

    if (type === 'assistant') {
      const msg = isRecord(raw.message) ? raw.message : null
      if (!msg) return
      const model = asString(msg.model) ?? this.currentModel
      ctx.emit({ type: 'message_start', message: { role: 'assistant', model } })
      // Register tool names so tool_result frames can label executions.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
            this.toolNames.set(block.id, asString(block.name) ?? 'tool')
            ctx.emit({
              type: 'tool_execution_start',
              toolCallId: block.id,
              toolName: asString(block.name) ?? 'tool',
              args: isRecord(block.input) ? block.input : {},
            })
          }
        }
      }
      ctx.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          model,
          stopReason: asString(msg.stop_reason) ?? 'stop',
          usage: mapUsage(msg.usage),
          content: canonicalContent(msg.content),
        },
      })
      return
    }

    if (type === 'user') {
      // Tool results arrive as user frames; surface them as tool_execution_end.
      const msg = isRecord(raw.message) ? raw.message : null
      const content = msg?.content
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_result') continue
        const toolCallId = asString(block.tool_use_id)
        if (!toolCallId) continue
        ctx.emit({
          type: 'tool_execution_end',
          toolCallId,
          toolName: this.toolNames.get(toolCallId) ?? 'tool',
          isError: block.is_error === true,
          result: { content: block.content },
        })
      }
      return
    }

    if (type === 'result') {
      this.streaming = false
      const usage = isRecord(raw.usage) ? raw.usage : null
      if (usage) {
        const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
        const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
        const cacheWrite = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
        this.lastContextTokens = input + cacheRead + cacheWrite
        ctx.state({
          contextUsage: {
            tokens: this.lastContextTokens,
            contextWindow: this.contextWindow(),
            percent: Math.min(100, Math.round((this.lastContextTokens / this.contextWindow()) * 1000) / 10),
          },
        })
      }
      const isError = raw.is_error === true || (asString(raw.subtype) ?? 'success') !== 'success'
      if (isError) {
        const detail = asString(raw.result) ?? asString(raw.subtype) ?? '执行失败'
        ctx.emit({ type: 'error', error: `Claude Code: ${detail}` })
      }
      this.blocks.clear()
      ctx.emit({ type: 'agent_end', stopReason: asString(raw.subtype) ?? 'success' })
      return
    }

    if (type === 'control_request') {
      this.handleControlRequest(raw, ctx)
      return
    }

    if (type === 'control_response') {
      const response = isRecord(raw.response) ? raw.response : null
      const requestId = response ? asString(response.request_id) : undefined
      if (!requestId) return
      const canonicalId = this.controlRequests.get(requestId)
      if (!canonicalId) return
      this.controlRequests.delete(requestId)
      if (response && response.subtype === 'success') {
        ctx.respond(canonicalId, {})
      } else {
        ctx.respond(canonicalId, null, asString(response?.error) ?? 'Claude Code 控制请求失败')
      }
      return
    }

    if (type === 'control_cancel_request') {
      const requestId = asString(raw.request_id)
      if (requestId && this.approvals.delete(requestId)) {
        // Approval withdrawn by the CLI; nothing to answer.
      }
      return
    }
  }

  handleUiResponse(response: ExtensionUiResponse, ctx: BridgeContext): void {
    const pending = this.approvals.get(response.id)
    if (!pending) return
    this.approvals.delete(response.id)
    const allowed = response.confirmed === true && response.cancelled !== true
    void writeJson(ctx, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: response.id,
        response: allowed
          ? { behavior: 'allow', updatedInput: pending.input }
          : { behavior: 'deny', message: '用户在 AgentUI 中拒绝了该操作' },
      },
    }).catch(() => undefined)
  }

  dispose(): void {
    this.approvals.clear()
    this.controlRequests.clear()
    this.blocks.clear()
  }

  private contextWindow(): number {
    return this.currentModel?.includes('[1m]') ? 1_000_000 : 200_000
  }

  private async writeUserMessage(command: RpcObject, ctx: BridgeContext): Promise<void> {
    const text = asString(command.message) ?? ''
    const content: RpcObject[] = []
    if (text) content.push({ type: 'text', text })
    if (Array.isArray(command.images)) {
      for (const img of command.images) {
        if (!isRecord(img) || typeof img.data !== 'string' || typeof img.mimeType !== 'string') continue
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '' })
    await writeJson(ctx, { type: 'user', message: { role: 'user', content } })
  }

  private handleStreamEvent(raw: unknown, ctx: BridgeContext): void {
    if (!isRecord(raw)) return
    const eventType = asString(raw.type)
    const index = typeof raw.index === 'number' ? raw.index : -1

    if (eventType === 'content_block_start') {
      const block = isRecord(raw.content_block) ? raw.content_block : null
      if (!block || index < 0) return
      const blockType = asString(block.type)
      if (blockType === 'tool_use') {
        const toolId = asString(block.id) ?? `call-${index}`
        const name = asString(block.name) ?? 'tool'
        this.blocks.set(index, { type: 'tool_use', id: toolId, name, argsJson: '' })
        this.toolNames.set(toolId, name)
        ctx.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'toolcall_start', id: toolId, toolName: name, contentIndex: index },
        })
      } else if (blockType === 'text' || blockType === 'thinking') {
        this.blocks.set(index, { type: blockType, argsJson: '' })
      }
      return
    }

    if (eventType === 'content_block_delta') {
      const delta = isRecord(raw.delta) ? raw.delta : null
      if (!delta) return
      const deltaType = asString(delta.type)
      const block = index >= 0 ? this.blocks.get(index) : undefined
      if (deltaType === 'text_delta') {
        ctx.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: asString(delta.text) ?? '' },
        })
      } else if (deltaType === 'thinking_delta') {
        ctx.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: asString(delta.thinking) ?? '' },
        })
      } else if (deltaType === 'input_json_delta' && block?.type === 'tool_use' && block.id) {
        const chunk = asString(delta.partial_json) ?? ''
        block.argsJson += chunk
        ctx.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'toolcall_delta', id: block.id, delta: chunk },
        })
      }
      return
    }

    if (eventType === 'content_block_stop') {
      const block = index >= 0 ? this.blocks.get(index) : undefined
      if (block?.type === 'tool_use' && block.id) {
        let args: RpcObject = {}
        try {
          const parsed: unknown = JSON.parse(block.argsJson || '{}')
          if (isRecord(parsed)) args = parsed
        } catch {
          // keep empty args on malformed JSON
        }
        ctx.emit({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            id: block.id,
            toolCall: { id: block.id, name: block.name ?? 'tool', arguments: args },
          },
        })
      }
      if (index >= 0) this.blocks.delete(index)
      return
    }

    if (eventType === 'message_start') {
      const msg = isRecord(raw.message) ? raw.message : null
      const model = msg ? asString(msg.model) : undefined
      if (model) this.currentModel = model
      ctx.emit({ type: 'message_start', message: { role: 'assistant', model } })
    }
  }

  private handleControlRequest(raw: RpcObject, ctx: BridgeContext): void {
    const requestId = asString(raw.request_id)
    const request = isRecord(raw.request) ? raw.request : null
    if (!requestId || !request) return
    const subtype = asString(request.subtype)

    if (subtype === 'can_use_tool') {
      const toolName = asString(request.tool_name) ?? 'tool'
      const input = isRecord(request.input) ? request.input : {}
      this.approvals.set(requestId, { toolName, input })
      let preview: string
      try {
        preview = JSON.stringify(input, null, 2)
      } catch {
        preview = String(input)
      }
      if (preview.length > 2000) preview = `${preview.slice(0, 2000)}\n…`
      ctx.emit({
        type: 'extension_ui_request',
        id: requestId,
        method: 'confirm',
        title: `Claude 请求执行 ${toolName}`,
        message: preview,
      })
      return
    }

    // Unknown control requests (hooks etc.): decline politely so the CLI continues.
    void writeJson(ctx, {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    }).catch(() => undefined)
  }
}