import { readFile, stat } from 'node:fs/promises'
import type { ExtensionUiResponse, ImageAttachment } from '@shared/types'
import { isRealPathInside } from '../../process-utils'
import type { RpcObject } from '../chunk-assembly'
import {
  asString,
  contentBlocksToText,
  isRecord,
  JsonRpcPeer,
  notify,
  unsupported,
  type BridgeContext,
  type BridgeStartInfo,
  type ProtocolBridge,
} from '../bridge'

export interface AcpBridgeOptions {
  /** Session path prefix, e.g. 'acp:' or 'dsh:' */
  sessionPrefix: string
  engineLabel: string
}

interface PermissionOption {
  optionId: string
  name: string
  kind?: string
}

interface PendingPermission {
  options: PermissionOption[]
  rawId: number | string
}

interface AcpModels {
  currentModelId?: string
  availableModels?: { modelId: string; name?: string }[]
}

export function acpSessionIdFromPath(sessionPath: string | null | undefined, prefix: string): string | null {
  if (!sessionPath) return null
  return sessionPath.startsWith(prefix) ? sessionPath.slice(prefix.length) : null
}

export class AcpBridge implements ProtocolBridge {
  private readonly peer: JsonRpcPeer
  private ctxRef: BridgeContext | null = null
  private sessionId: string | null = null
  private streaming = false
  private agentCapabilities: RpcObject = {}
  private models: AcpModels | null = null
  private commands: RpcObject[] = []
  private readonly permissions = new Map<string, PendingPermission>()
  private promptInFlight = false

  constructor(
    private readonly info: BridgeStartInfo,
    private readonly options: AcpBridgeOptions,
  ) {
    this.sessionId = acpSessionIdFromPath(info.sessionPath, options.sessionPrefix)
    this.peer = new JsonRpcPeer((message) => this.write(message))
  }

  private write(message: RpcObject): Promise<void> {
    if (!this.ctxRef) return Promise.reject(new Error('ACP bridge not initialized'))
    return this.ctxRef.writeLine(`${JSON.stringify(message)}\n`)
  }

  async initialize(ctx: BridgeContext): Promise<void> {
    this.ctxRef = ctx
    const init = await this.peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
    })
    this.agentCapabilities = isRecord(init.agentCapabilities) ? init.agentCapabilities : {}

    if (this.sessionId && this.agentCapabilities.loadSession === true) {
      // Replay history through session/update notifications into the timeline.
      ctx.emit({ type: 'agent_start' })
      try {
        await this.peer.request('session/load', { sessionId: this.sessionId, cwd: ctx.cwd, mcpServers: [] }, 60_000)
      } finally {
        ctx.emit({ type: 'agent_end' })
      }
      ctx.state({ sessionFile: `${this.options.sessionPrefix}${this.sessionId}` })
      return
    }

    const res = await this.peer.request('session/new', { cwd: ctx.cwd, mcpServers: [] }, 60_000)
    const sessionId = asString(res.sessionId)
    if (!sessionId) throw new Error(`${this.options.engineLabel} 未返回 ACP sessionId`)
    this.sessionId = sessionId
    if (isRecord(res.models)) this.models = res.models as AcpModels
    ctx.state({
      sessionFile: `${this.options.sessionPrefix}${sessionId}`,
      modelProvider: this.options.engineLabel.toLowerCase(),
      modelId: this.models?.currentModelId ?? this.info.modelId ?? null,
    })
  }

  async encodeCommand(command: RpcObject, ctx: BridgeContext): Promise<void> {
    this.ctxRef = ctx
    const id = asString(command.id) ?? ''
    const type = asString(command.type) ?? ''
    switch (type) {
      case 'prompt': {
        if (!this.sessionId) {
          ctx.respond(id, null, 'ACP 会话尚未初始化')
          return
        }
        const prompt = this.buildPromptBlocks(command, ctx)
        this.streaming = true
        this.promptInFlight = true
        ctx.emit({ type: 'agent_start' })
        // session/prompt resolves only when the turn ends; answer the canonical
        // prompt command immediately and translate the eventual response to agent_end.
        ctx.respond(id, {})
        void this.peer
          .request('session/prompt', { sessionId: this.sessionId, prompt }, 30 * 60_000)
          .then((res) => {
            this.promptInFlight = false
            this.streaming = false
            ctx.emit({ type: 'agent_end', stopReason: asString(res.stopReason) ?? 'end_turn' })
          })
          .catch((err) => {
            this.promptInFlight = false
            this.streaming = false
            ctx.emit({ type: 'error', error: `${this.options.engineLabel}: ${err instanceof Error ? err.message : String(err)}` })
            ctx.emit({ type: 'agent_end' })
          })
        return
      }
      case 'abort': {
        if (!this.sessionId || !this.promptInFlight) {
          ctx.respond(id, {})
          return
        }
        await this.peer.notify('session/cancel', { sessionId: this.sessionId })
        ctx.respond(id, {})
        return
      }
      case 'set_model': {
        const modelId = asString(command.modelId)
        if (!modelId) {
          ctx.respond(id, null, '缺少 modelId')
          return
        }
        if (!this.sessionId || !this.models?.availableModels?.length) {
          unsupported(ctx, id, '模型切换（Agent 未声明模型列表）')
          return
        }
        try {
          await this.peer.request('session/set_model', { sessionId: this.sessionId, modelId }, 15_000)
          if (this.models) this.models.currentModelId = modelId
          ctx.state({ modelId })
          ctx.respond(id, {})
        } catch (err) {
          ctx.respond(id, null, err instanceof Error ? err.message : String(err))
        }
        return
      }
      case 'get_state': {
        ctx.respond(id, {
          isStreaming: this.streaming,
          isCompacting: false,
          sessionFile: this.sessionId ? `${this.options.sessionPrefix}${this.sessionId}` : null,
          model: this.models?.currentModelId
            ? { provider: this.options.engineLabel.toLowerCase(), id: this.models.currentModelId }
            : null,
        })
        return
      }
      case 'get_session_stats': {
        ctx.respond(id, { contextUsage: null })
        return
      }
      case 'get_commands': {
        ctx.respond(id, { commands: this.commands })
        return
      }
      case 'set_thinking_level':
      case 'compact':
      case 'steer':
      case 'follow_up':
      case 'fork':
      case 'branch':
      case 'clone':
      case 'get_fork_messages': {
        unsupported(ctx, id, type)
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

    if (raw.id !== undefined && raw.id !== null) {
      this.handleServerRequest(method, params, raw.id, ctx)
      return
    }

    if (method === 'session/update') {
      this.handleSessionUpdate(params, ctx)
    }
  }

  handleUiResponse(response: ExtensionUiResponse, ctx: BridgeContext): void {
    const pending = this.permissions.get(response.id)
    if (!pending) return
    this.permissions.delete(response.id)
    void ctx
    const numericId = pending.rawId
    if (response.cancelled === true || !response.value) {
      void this.peer.respond(numericId, { outcome: { outcome: 'cancelled' } }).catch(() => undefined)
      return
    }
    const option =
      pending.options.find((o) => o.optionId === response.value) ??
      pending.options.find((o) => o.name === response.value)
    if (!option) {
      void this.peer.respond(numericId, { outcome: { outcome: 'cancelled' } }).catch(() => undefined)
      return
    }
    void this.peer
      .respond(numericId, { outcome: { outcome: 'selected', optionId: option.optionId } })
      .catch(() => undefined)
  }

  dispose(error: Error): void {
    this.peer.dispose(error)
    this.permissions.clear()
  }

  private buildPromptBlocks(command: RpcObject, ctx: BridgeContext): RpcObject[] {
    const blocks: RpcObject[] = []
    const text = asString(command.message) ?? ''
    if (text) blocks.push({ type: 'text', text })
    const images = Array.isArray(command.images) ? (command.images as ImageAttachment[]) : []
    const promptCaps = isRecord(this.agentCapabilities.promptCapabilities) ? this.agentCapabilities.promptCapabilities : {}
    if (images.length > 0) {
      if (promptCaps.image === true) {
        for (const img of images) {
          if (img?.data && img.mimeType) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType })
        }
      } else {
        notify(ctx, `${this.options.engineLabel} 不支持图片输入，已忽略附件。`, 'warning')
      }
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    return blocks
  }

  private handleSessionUpdate(params: RpcObject, ctx: BridgeContext): void {
    const update = isRecord(params.update) ? params.update : null
    if (!update) return
    const kind = asString(update.sessionUpdate)

    if (kind === 'agent_message_chunk') {
      const text = contentBlocksToText([update.content])
      if (text) ctx.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
      return
    }
    if (kind === 'agent_thought_chunk') {
      const text = contentBlocksToText([update.content])
      if (text) ctx.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: text } })
      return
    }
    if (kind === 'user_message_chunk') {
      const text = contentBlocksToText([update.content])
      if (text) ctx.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } })
      return
    }
    if (kind === 'tool_call') {
      const toolCallId = asString(update.toolCallId)
      if (!toolCallId) return
      ctx.emit({
        type: 'tool_execution_start',
        toolCallId,
        toolName: asString(update.title) ?? asString(update.kind) ?? 'tool',
        args: isRecord(update.rawInput) ? update.rawInput : {},
      })
      return
    }
    if (kind === 'tool_call_update') {
      const toolCallId = asString(update.toolCallId)
      if (!toolCallId) return
      const status = asString(update.status)
      const output = contentBlocksToText(update.content) || (update.rawOutput != null ? JSON.stringify(update.rawOutput, null, 2) : '')
      if (status === 'completed' || status === 'failed') {
        ctx.emit({
          type: 'tool_execution_end',
          toolCallId,
          toolName: asString(update.title) ?? 'tool',
          isError: status === 'failed',
          result: { output },
        })
      } else if (output) {
        ctx.emit({
          type: 'tool_execution_update',
          toolCallId,
          partialResult: { output },
        })
      }
      return
    }
    if (kind === 'available_commands_update') {
      const list = Array.isArray(update.availableCommands) ? update.availableCommands : []
      this.commands = list
        .filter(isRecord)
        .map((c) => ({
          name: (asString(c.name) ?? '').replace(/^\/+/, ''),
          description: asString(c.description),
          source: 'extension',
        }))
        .filter((c) => c.name)
      return
    }
    if (kind === 'current_mode_update') {
      ctx.state({ statusText: asString(update.currentModeId) ?? null })
      return
    }
    if (kind === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : []
      const text = entries
        .filter(isRecord)
        .map((e) => `- [${asString(e.status) ?? 'pending'}] ${asString(e.content) ?? ''}`)
        .join('\n')
      if (text) notify(ctx, `计划更新:\n${text}`)
    }
  }

  private handleServerRequest(method: string, params: RpcObject, rawId: unknown, ctx: BridgeContext): void {
    const id = String(rawId)
    if (method === 'session/request_permission') {
      const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
      const rawOptions = Array.isArray(params.options) ? params.options : []
      const options: PermissionOption[] = rawOptions.filter(isRecord).map((o) => ({
        optionId: asString(o.optionId) ?? '',
        name: asString(o.name) ?? asString(o.optionId) ?? '选项',
        kind: asString(o.kind),
      })).filter((o) => o.optionId)
      if (options.length === 0) {
        void this.peer.respond(rawId as number | string, { outcome: { outcome: 'cancelled' } }).catch(() => undefined)
        return
      }
      this.permissions.set(id, { options, rawId: rawId as number | string })
      const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : null
      let inputText = ''
      if (rawInput) {
        const cmd = asString(rawInput.command) ?? asString(rawInput.cmd)
        const path = asString(rawInput.file_path) ?? asString(rawInput.path)
        if (cmd) inputText = cmd
        else if (path) inputText = path
        else {
          try {
            inputText = JSON.stringify(rawInput).slice(0, 2000)
          } catch {
            inputText = ''
          }
        }
      }
      const head = asString(toolCall.title) ?? asString(toolCall.kind) ?? 'Agent 需要你的确认'
      ctx.emit({
        type: 'extension_ui_request',
        id,
        method: 'select',
        title: `${this.options.engineLabel} 请求权限`,
        message: inputText ? `${head}\n${inputText}` : head,
        options: options.map((o) => o.name),
      })
      return
    }
    if (method === 'fs/read_text_file') {
      void this.handleFsRead(params, rawId as number | string, ctx)
      return
    }
    if (method === 'fs/write_text_file') {
      void this.peer
        .respondError(rawId as number | string, -32603, 'AgentUI 以只读客户端运行，拒绝 Agent 直接写入文件')
        .catch(() => undefined)
      return
    }
    void this.peer
      .respondError(rawId as number | string, -32601, `AgentUI 暂不支持 ${method}`)
      .catch(() => undefined)
  }

  private async handleFsRead(params: RpcObject, rawId: number | string, ctx: BridgeContext): Promise<void> {
    const path = asString(params.path)
    if (!path || !isRealPathInside(ctx.cwd, path)) {
      await this.peer.respondError(rawId, -32602, '仅允许读取工作区内的文件').catch(() => undefined)
      return
    }
    try {
      const st = await stat(path)
      if (!st.isFile() || st.size > 5 * 1024 * 1024) {
        await this.peer.respondError(rawId, -32602, '文件过大或不是普通文件（上限 5MB）').catch(() => undefined)
        return
      }
      let content = await readFile(path, 'utf8')
      const line = typeof params.line === 'number' && params.line > 0 ? params.line : null
      const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : null
      if (line !== null || limit !== null) {
        const lines = content.split('\n')
        const start = (line ?? 1) - 1
        content = lines.slice(start, limit !== null ? start + limit : undefined).join('\n')
      }
      await this.peer.respond(rawId, { content })
    } catch (err) {
      await this.peer
        .respondError(rawId, -32603, err instanceof Error ? err.message : String(err))
        .catch(() => undefined)
    }
  }
}