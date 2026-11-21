import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionUiResponse, ImageAttachment, ThinkingLevel } from '@shared/types'
import type { RpcObject } from '../chunk-assembly'
import {
  asString,
  isRecord,
  JsonRpcPeer,
  notify,
  unsupported,
  type BridgeContext,
  type BridgeStartInfo,
  type ProtocolBridge,
} from '../bridge'

export const CODEX_SESSION_PREFIX = 'codex:'

export function codexThreadIdFromSessionPath(sessionPath: string | null | undefined): string | null {
  if (!sessionPath) return null
  return sessionPath.startsWith(CODEX_SESSION_PREFIX) ? sessionPath.slice(CODEX_SESSION_PREFIX.length) : null
}

interface PendingApproval {
  kind: 'command' | 'fileChange'
  rawId: number | string
}

function itemToolName(item: RpcObject): string {
  const type = asString(item.type)
  if (type === 'commandExecution') return 'shell'
  if (type === 'fileChange') return 'apply_patch'
  if (type === 'mcpToolCall') return `${asString(item.server) ?? 'mcp'}/${asString(item.tool) ?? 'tool'}`
  if (type === 'dynamicToolCall') return asString(item.tool) ?? 'tool'
  if (type === 'webSearch') return 'web_search'
  return type ?? 'tool'
}

function itemArgs(item: RpcObject): RpcObject {
  const type = asString(item.type)
  if (type === 'commandExecution') return { command: item.command, cwd: item.cwd }
  if (type === 'fileChange') return { changes: item.changes }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') return isRecord(item.arguments) ? item.arguments : {}
  if (type === 'webSearch') return { query: item.query }
  return {}
}

function itemOutput(item: RpcObject, accumulated: string): string {
  const type = asString(item.type)
  if (type === 'commandExecution') {
    return asString(item.aggregatedOutput) ?? accumulated
  }
  if (type === 'fileChange') {
    if (Array.isArray(item.changes)) {
      const diffs = item.changes
        .map((c) => (isRecord(c) ? `${asString(c.path) ?? ''}\n${asString(c.diff) ?? ''}` : ''))
        .filter(Boolean)
      if (diffs.length > 0) return diffs.join('\n\n')
    }
    return accumulated
  }
  if (type === 'mcpToolCall') {
    if (item.error != null) return typeof item.error === 'string' ? item.error : JSON.stringify(item.error)
    if (item.result != null) return typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2)
    return accumulated
  }
  if (type === 'dynamicToolCall') {
    if (Array.isArray(item.contentItems)) return JSON.stringify(item.contentItems, null, 2)
    return accumulated
  }
  if (type === 'webSearch') return asString(item.query) ?? ''
  return accumulated
}

function itemFailed(item: RpcObject): boolean {
  const status = asString(item.status)
  if (status === 'failed' || status === 'declined') return true
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return true
  if (item.error != null) return true
  if (item.success === false) return true
  return false
}

export class CodexAppServerBridge implements ProtocolBridge {
  private readonly peer: JsonRpcPeer
  private threadId: string | null = null
  private currentModel: string | null
  private thinkingLevel: ThinkingLevel
  private streaming = false
  private readonly toolOutput = new Map<string, string>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly tempDirs: string[] = []
  private lastUsage: { tokens: number; contextWindow: number } | null = null

  constructor(private readonly info: BridgeStartInfo) {
    this.currentModel = info.modelId ?? null
    this.thinkingLevel = info.thinkingLevel ?? 'medium'
    this.threadId = codexThreadIdFromSessionPath(info.sessionPath)
    this.peer = new JsonRpcPeer((message) => this.write(message))
  }

  private ctxRef: BridgeContext | null = null

  private write(message: RpcObject): Promise<void> {
    if (!this.ctxRef) return Promise.reject(new Error('Codex bridge not initialized'))
    return this.ctxRef.writeLine(`${JSON.stringify(message)}\n`)
  }

  async initialize(ctx: BridgeContext): Promise<void> {
    this.ctxRef = ctx
    await this.peer.request('initialize', {
      clientInfo: { name: 'agentui', title: 'AgentUI', version: '0.1.0' },
    })
    await this.peer.notify('initialized', {})

    if (this.threadId) {
      const res = await this.peer.request('thread/resume', { threadId: this.threadId, excludeTurns: true })
      this.applyThread(res, ctx)
    } else {
      const params: RpcObject = {
        cwd: ctx.cwd,
        approvalPolicy: 'on-request',
        sandbox: this.sandboxMode(),
      }
      if (this.currentModel) params.model = this.currentModel
      const res = await this.peer.request('thread/start', params)
      this.applyThread(res, ctx)
    }
  }

  /** Align Codex's own sandbox with the project trust preset (read-only observation → read-only sandbox). */
  private sandboxMode(): 'read-only' | 'workspace-write' {
    return this.info.getTrustPreset?.() === 'readonly' ? 'read-only' : 'workspace-write'
  }

  private applyThread(res: RpcObject, ctx: BridgeContext): void {
    const thread = isRecord(res.thread) ? res.thread : null
    const id = thread ? asString(thread.id) : undefined
    if (!id) throw new Error('Codex app-server 未返回 thread id')
    this.threadId = id
    const model = thread ? asString(thread.model) : undefined
    if (model) this.currentModel = model
    ctx.state({
      sessionFile: `${CODEX_SESSION_PREFIX}${id}`,
      modelProvider: 'openai',
      modelId: this.currentModel,
    })
  }

  async encodeCommand(command: RpcObject, ctx: BridgeContext): Promise<void> {
    this.ctxRef = ctx
    const id = asString(command.id) ?? ''
    const type = asString(command.type) ?? ''
    switch (type) {
      case 'prompt':
      case 'steer': {
        if (!this.threadId) {
          ctx.respond(id, null, 'Codex 会话尚未初始化')
          return
        }
        const input = await this.buildInput(command)
        const method = type === 'steer' && this.streaming ? 'turn/steer' : 'turn/start'
        const params: RpcObject = { threadId: this.threadId, input }
        if (method === 'turn/start') {
          params.cwd = ctx.cwd
          params.approvalPolicy = 'on-request'
          params.sandboxPolicy = { type: this.sandboxMode() === 'read-only' ? 'readOnly' : 'workspaceWrite' }
          if (this.currentModel) params.model = this.currentModel
        }
        this.streaming = true
        ctx.emit({ type: 'agent_start' })
        try {
          await this.peer.request(method, params, 60_000)
          ctx.respond(id, {})
        } catch (err) {
          this.streaming = false
          ctx.emit({ type: 'agent_end' })
          ctx.respond(id, null, err instanceof Error ? err.message : String(err))
        }
        return
      }
      case 'abort': {
        if (!this.threadId || !this.streaming) {
          ctx.respond(id, {})
          return
        }
        try {
          await this.peer.request('turn/interrupt', { threadId: this.threadId }, 10_000)
          ctx.respond(id, {})
        } catch (err) {
          ctx.respond(id, null, err instanceof Error ? err.message : String(err))
        }
        return
      }
      case 'compact': {
        if (!this.threadId) {
          ctx.respond(id, null, 'Codex 会话尚未初始化')
          return
        }
        try {
          await this.peer.request('thread/compact/start', { threadId: this.threadId }, 15_000)
          ctx.respond(id, {})
        } catch (err) {
          ctx.respond(id, null, err instanceof Error ? err.message : String(err))
        }
        return
      }
      case 'set_model': {
        const model = asString(command.modelId)
        if (!model) {
          ctx.respond(id, null, '缺少 modelId')
          return
        }
        this.currentModel = model
        ctx.state({ modelProvider: 'openai', modelId: model })
        ctx.respond(id, {})
        return
      }
      case 'set_thinking_level': {
        const level = asString(command.level) as ThinkingLevel | undefined
        if (level) this.thinkingLevel = level
        ctx.respond(id, {})
        notify(ctx, 'Codex 的推理强度由模型默认 reasoning effort 决定，档位偏好已记录。')
        return
      }
      case 'get_state': {
        ctx.respond(id, {
          isStreaming: this.streaming,
          isCompacting: false,
          sessionFile: this.threadId ? `${CODEX_SESSION_PREFIX}${this.threadId}` : null,
          model: this.currentModel ? { provider: 'openai', id: this.currentModel } : null,
          thinkingLevel: this.thinkingLevel,
        })
        return
      }
      case 'get_session_stats': {
        ctx.respond(id, {
          contextUsage: this.lastUsage
            ? {
                tokens: this.lastUsage.tokens,
                contextWindow: this.lastUsage.contextWindow,
                percent: Math.min(100, Math.round((this.lastUsage.tokens / this.lastUsage.contextWindow) * 1000) / 10),
              }
            : null,
        })
        return
      }
      case 'fork':
      case 'branch':
      case 'clone': {
        if (!this.threadId) {
          ctx.respond(id, null, 'Codex 会话尚未初始化')
          return
        }
        try {
          const res = await this.peer.request('thread/fork', { threadId: this.threadId, excludeTurns: true })
          const thread = isRecord(res.thread) ? res.thread : null
          const newId = thread ? asString(thread.id) : undefined
          if (newId) {
            this.threadId = newId
            ctx.state({ sessionFile: `${CODEX_SESSION_PREFIX}${newId}` })
          }
          if (command.entryId) notify(ctx, 'Codex 仅支持整段会话分叉，已忽略所选消息节点。', 'warning')
          ctx.respond(id, {})
        } catch (err) {
          ctx.respond(id, null, err instanceof Error ? err.message : String(err))
        }
        return
      }
      case 'get_commands':
      case 'get_fork_messages': {
        unsupported(ctx, id, type === 'get_commands' ? '斜杠命令发现' : '消息级分支树')
        return
      }
      default: {
        unsupported(ctx, id, `命令 ${type}`)
      }
    }
  }

  handleFrame(raw: unknown, ctx: BridgeContext): void {
    if (!isRecord(raw)) return
    this.ctxRef = ctx
    if (this.peer.handleResponse(raw)) return

    const method = asString(raw.method)
    if (!method) return
    const params = isRecord(raw.params) ? raw.params : {}

    // Server-initiated requests (approvals etc.)
    if (raw.id !== undefined && raw.id !== null) {
      this.handleServerRequest(method, params, raw.id, ctx)
      return
    }

    switch (method) {
      case 'turn/started': {
        // turn/start already emitted agent_start optimistically; don't duplicate it.
        const alreadyRunning = this.streaming
        this.streaming = true
        if (!alreadyRunning) ctx.emit({ type: 'agent_start' })
        return
      }
      case 'turn/completed': {
        this.streaming = false
        // Approvals cannot outlive their turn (e.g. after an interrupt): drop stale cards.
        this.dismissPendingApprovals(ctx)
        const turn = isRecord(params.turn) ? params.turn : null
        const status = turn ? asString(turn.status) : undefined
        if (status === 'failed') {
          const error = turn && isRecord(turn.error) ? turn.error : null
          ctx.emit({ type: 'error', error: `Codex: ${asString(error?.message) ?? '回合执行失败'}` })
        }
        this.toolOutput.clear()
        ctx.emit({ type: 'agent_end', stopReason: status ?? 'completed' })
        return
      }
      case 'item/started': {
        this.handleItemStarted(params, ctx)
        return
      }
      case 'item/completed': {
        this.handleItemCompleted(params, ctx)
        return
      }
      case 'item/agentMessage/delta': {
        const delta = asString(params.delta) ?? ''
        if (delta) {
          ctx.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
        }
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = asString(params.delta) ?? ''
        if (delta) {
          ctx.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta } })
        }
        return
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = asString(params.itemId)
        const delta = asString(params.delta) ?? ''
        if (!itemId || !delta) return
        const acc = (this.toolOutput.get(itemId) ?? '') + delta
        this.toolOutput.set(itemId, acc)
        ctx.emit({
          type: 'tool_execution_update',
          toolCallId: itemId,
          toolName: 'shell',
          partialResult: { output: acc },
        })
        return
      }
      case 'thread/tokenUsage/updated': {
        this.handleTokenUsage(params, ctx)
        return
      }
      case 'serverRequest/resolved': {
        // The approval was answered elsewhere (another client / the CLI itself).
        const resolvedId = params.id ?? params.requestId
        const key = resolvedId !== undefined && resolvedId !== null ? String(resolvedId) : null
        if (key && this.approvals.delete(key)) {
          ctx.emit({ type: 'extension_ui_request', method: 'dismiss', id: key })
        }
        return
      }
      case 'error': {
        const error = isRecord(params.error) ? params.error : params
        const message = asString(error.message) ?? 'Codex 运行时错误'
        if (params.willRetry === true || error.willRetry === true) {
          notify(ctx, `Codex 将重试: ${message}`, 'warning')
        } else {
          ctx.emit({ type: 'error', error: `Codex: ${message}` })
        }
        return
      }
      case 'warning': {
        notify(ctx, asString(params.message) ?? 'Codex 警告', 'warning')
        return
      }
      default:
        // thread/started, turn/diff/updated etc. are informational.
        return
    }
  }

  handleUiResponse(response: ExtensionUiResponse, _ctx: BridgeContext): void {
    const pending = this.approvals.get(response.id)
    if (!pending) return
    this.approvals.delete(response.id)
    const decision = response.confirmed === true && response.cancelled !== true ? 'accept' : 'decline'
    void this.peer.respond(pending.rawId, { decision }).catch(() => undefined)
  }

  dispose(error: Error): void {
    this.peer.dispose(error)
    this.approvals.clear()
    this.toolOutput.clear()
    for (const dir of this.tempDirs.splice(0)) {
      void rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async buildInput(command: RpcObject): Promise<RpcObject[]> {
    const input: RpcObject[] = []
    const text = asString(command.message) ?? ''
    if (text) input.push({ type: 'text', text })
    const images = Array.isArray(command.images) ? (command.images as ImageAttachment[]) : []
    if (images.length > 0) {
      const dir = await mkdtemp(join(tmpdir(), 'agentui-codex-img-'))
      this.tempDirs.push(dir)
      for (let i = 0; i < images.length; i += 1) {
        const img = images[i]
        if (!img?.data || !img.mimeType) continue
        const ext = img.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
        const file = join(dir, `image-${i}.${ext}`)
        await writeFile(file, Buffer.from(img.data, 'base64'))
        input.push({ type: 'localImage', path: file })
      }
    }
    if (input.length === 0) input.push({ type: 'text', text: '' })
    return input
  }

  private handleItemStarted(params: RpcObject, ctx: BridgeContext): void {
    const item = isRecord(params.item) ? params.item : null
    if (!item) return
    const type = asString(item.type)
    const itemId = asString(item.id) ?? ''
    if (type === 'agentMessage') {
      ctx.emit({ type: 'message_start', message: { role: 'assistant', model: this.currentModel } })
      return
    }
    if (type === 'contextCompaction') {
      ctx.emit({ type: 'compaction_start', reason: 'auto' })
      return
    }
    if (type === 'userMessage' || type === 'reasoning' || type === 'plan') return
    if (!itemId) return
    ctx.emit({
      type: 'tool_execution_start',
      toolCallId: itemId,
      toolName: itemToolName(item),
      args: itemArgs(item),
    })
  }

  private handleItemCompleted(params: RpcObject, ctx: BridgeContext): void {
    const item = isRecord(params.item) ? params.item : null
    if (!item) return
    const type = asString(item.type)
    const itemId = asString(item.id) ?? ''
    if (type === 'agentMessage') {
      ctx.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          model: this.currentModel,
          stopReason: 'stop',
          content: [{ type: 'text', text: asString(item.text) ?? '' }],
        },
      })
      return
    }
    if (type === 'contextCompaction') {
      ctx.emit({ type: 'compaction_end', result: {} })
      return
    }
    if (type === 'userMessage' || type === 'reasoning' || type === 'plan') return
    if (!itemId) return
    const accumulated = this.toolOutput.get(itemId) ?? ''
    this.toolOutput.delete(itemId)
    ctx.emit({
      type: 'tool_execution_end',
      toolCallId: itemId,
      toolName: itemToolName(item),
      isError: itemFailed(item),
      result: { output: itemOutput(item, accumulated) },
      durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
    })
  }

  private handleTokenUsage(params: RpcObject, ctx: BridgeContext): void {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : params
    const last = isRecord(usage.last) ? usage.last : isRecord(usage.last_token_usage) ? usage.last_token_usage : usage
    const window =
      typeof usage.modelContextWindow === 'number'
        ? usage.modelContextWindow
        : typeof usage.model_context_window === 'number'
          ? usage.model_context_window
          : typeof params.modelContextWindow === 'number'
            ? params.modelContextWindow
            : 272_000
    const input = typeof last.input_tokens === 'number' ? last.input_tokens : typeof last.inputTokens === 'number' ? last.inputTokens : 0
    const cached =
      typeof last.cached_input_tokens === 'number'
        ? last.cached_input_tokens
        : typeof last.cachedInputTokens === 'number'
          ? last.cachedInputTokens
          : 0
    const output = typeof last.output_tokens === 'number' ? last.output_tokens : typeof last.outputTokens === 'number' ? last.outputTokens : 0
    const total = input + cached + output
    if (total <= 0 || window <= 0) return
    this.lastUsage = { tokens: total, contextWindow: window }
    ctx.state({
      contextUsage: {
        tokens: total,
        contextWindow: window,
        percent: Math.min(100, Math.round((total / window) * 1000) / 10),
      },
    })
  }

  private dismissPendingApprovals(ctx: BridgeContext): void {
    for (const id of this.approvals.keys()) {
      ctx.emit({ type: 'extension_ui_request', method: 'dismiss', id })
    }
    this.approvals.clear()
  }

  private handleServerRequest(method: string, params: RpcObject, rawId: unknown, ctx: BridgeContext): void {
    const id = String(rawId)
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const kind = method.includes('commandExecution') ? 'command' : 'fileChange'
      this.approvals.set(id, { kind, rawId: rawId as number | string })
      const command = asString(params.command)
      const reason = asString(params.reason)
      const grantRoot = asString(params.grantRoot)
      const files = isRecord(params.changes)
        ? Object.keys(params.changes)
        : Array.isArray(params.changes)
          ? params.changes.map((c) => (isRecord(c) ? asString(c.path) : undefined)).filter((p): p is string => !!p)
          : []
      const fileLines = [...files.slice(0, 20), ...(grantRoot ? [`授权目录: ${grantRoot}`] : [])].join('\n')
      const message =
        kind === 'command'
          ? `${command ?? '(命令详情见会话)'}${reason ? `\n\n原因: ${reason}` : ''}`
          : `Codex 请求修改工作区文件${fileLines ? `:\n${fileLines}` : ''}${reason ? `\n\n原因: ${reason}` : ''}`
      ctx.emit({
        type: 'extension_ui_request',
        id,
        method: 'confirm',
        title: kind === 'command' ? 'Codex 请求执行命令' : 'Codex 请求应用文件变更',
        message,
        command: kind === 'command' ? command : undefined,
      })
      return
    }
    if (method === 'item/permissions/requestApproval') {
      // Grant nothing by default; the agent continues with restricted permissions.
      void this.peer.respond(rawId as number | string, { permissions: {}, scope: 'turn' }).catch(() => undefined)
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      void this.peer.respond(rawId as number | string, { action: 'decline', content: null }).catch(() => undefined)
      return
    }
    // Unknown server requests (attestation, dynamic tools, user input forms):
    // answer with a JSON-RPC error so Codex can fall back gracefully.
    void this.peer
      .respondError(rawId as number | string, -32601, `AgentUI 暂不支持 ${method}`)
      .catch(() => undefined)
  }
}
