import type { ContextUsageInfo, ExtensionUiResponse, ThinkingLevel } from '@shared/types'
import type { RpcObject } from './chunk-assembly'

/**
 * Unified transport abstraction.
 *
 * The canonical internal protocol is the Pi-style JSONL RPC consumed by
 * RpcRuntime / RuntimeManager / event-reducer:
 *   commands  -> { type, id, ... }
 *   responses -> { type: 'response', id, success, data? }
 *   events    -> agent_start / message_start / message_update / message_end /
 *                tool_execution_* / agent_end / extension_ui_request / ...
 *
 * Engines with a different native wire protocol (Claude Code stream-json,
 * Codex app-server JSON-RPC, ACP JSON-RPC, dsh --profile acp) implement a
 * ProtocolBridge that translates between the native protocol and this
 * canonical vocabulary, so the rest of the app stays engine-agnostic.
 */
export interface BridgeStatePatch {
  isStreaming?: boolean
  isCompacting?: boolean
  sessionFile?: string | null
  modelProvider?: string | null
  modelId?: string | null
  thinkingLevel?: ThinkingLevel
  contextUsage?: ContextUsageInfo
  statusText?: string | null
}

export interface BridgeContext {
  readonly cwd: string
  readonly sessionPath: string | null
  readonly providerId: string | null
  readonly modelId: string | null
  readonly thinkingLevel: ThinkingLevel
  writeLine(line: string): Promise<void>
  /** Resolve (data) or reject (error) the pending canonical command with this id. */
  respond(id: string, data?: RpcObject | null, error?: string): void
  /** Emit a canonical event; runs through runtime state tracking and the timeline reducer. */
  emit(event: RpcObject): void
  state(patch: BridgeStatePatch): void
}

export interface ProtocolBridge {
  /** Native handshake (initialize / session creation). Called once after spawn. */
  initialize(ctx: BridgeContext): Promise<void>
  /** Translate a canonical command (already carrying its `id`) into native wire messages. */
  encodeCommand(command: RpcObject, ctx: BridgeContext): void | Promise<void>
  /** Consume one native stdout frame. */
  handleFrame(raw: unknown, ctx: BridgeContext): void
  /** Route an extension UI approval answer back to the native protocol. */
  handleUiResponse(response: ExtensionUiResponse, ctx: BridgeContext): void
  /** Reject any native in-flight requests when the process dies. */
  dispose?(error: Error): void
}

export interface BridgeStartInfo {
  cwd: string
  sessionPath?: string | null
  providerId?: string | null
  modelId?: string | null
  thinkingLevel?: ThinkingLevel
  executablePath: string
  /** Current project trust preset; read per turn so preset changes apply without a restart. */
  getTrustPreset?: () => import('@shared/tool-policy').TrustPreset
}

export function isRecord(value: unknown): value is RpcObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function writeJson(ctx: BridgeContext, message: RpcObject): Promise<void> {
  return ctx.writeLine(`${JSON.stringify(message)}\n`)
}

export function unsupported(ctx: BridgeContext, id: string, what: string): void {
  ctx.respond(id, null, `当前引擎不支持 ${what}`)
}

export function notify(ctx: BridgeContext, message: string, notifyType: 'info' | 'warning' | 'error' = 'info'): void {
  ctx.emit({ type: 'extension_ui_request', method: 'notify', notifyType, message })
}

/** Extract plain text from ACP / Anthropic-style content block arrays. */
export function contentBlocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'content' && isRecord(block.content) && typeof block.content.text === 'string') {
      parts.push(block.content.text)
    }
  }
  return parts.join('\n')
}

interface PeerPending {
  resolve: (result: RpcObject) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/**
 * Minimal JSON-RPC 2.0 peer used by the Codex and ACP bridges.
 * Handles client requests, notifications and server-initiated requests.
 */
export class JsonRpcPeer {
  private nextId = 1
  private readonly pending = new Map<number, PeerPending>()
  private disposed = false

  constructor(private readonly write: (message: RpcObject) => Promise<void>) {}

  request(method: string, params: RpcObject = {}, timeoutMs = 30_000): Promise<RpcObject> {
    if (this.disposed) return Promise.reject(new Error('JSON-RPC peer disposed'))
    const id = this.nextId++
    return new Promise<RpcObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`JSON-RPC ${method} 超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
      void this.write({ jsonrpc: '2.0', id, method, params }).catch((err) => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  notify(method: string, params: RpcObject = {}): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number | string, result: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: number | string, code: number, message: string): Promise<void> {
    return this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /** Returns true when the frame was a response to one of our requests. */
  handleResponse(raw: RpcObject): boolean {
    if (raw.id === undefined || raw.id === null || raw.method !== undefined) return false
    if (typeof raw.id !== 'number') return false
    const entry = this.pending.get(raw.id)
    if (!entry) return false
    this.pending.delete(raw.id)
    clearTimeout(entry.timer)
    if (isRecord(raw.error)) {
      entry.reject(new Error(asString(raw.error.message) ?? `JSON-RPC ${entry.method} 失败`))
    } else {
      entry.resolve(isRecord(raw.result) ? raw.result : {})
    }
    return true
  }

  dispose(error: Error): void {
    this.disposed = true
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }
}