import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ContextUsageInfo, ExtensionUiRequest, ExtensionUiResponse, ThinkingLevel } from '@shared/types'
import { killProcessTree, prepareExecutableSpawn, safeChildEnvironment } from '../process-utils'
import type { HarnessRpcAdapter } from './adapters'
import { parseContextUsage } from './adapters'
import type { BridgeContext, BridgeStartInfo, ProtocolBridge } from './bridge'
import { RpcChunkAssembler, type RpcObject } from './chunk-assembly'
import { StrictJsonlDecoder } from './jsonl'

interface PendingRequest {
  command: string
  resolve: (value: RpcObject) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface RpcRuntimeExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
  unexpected: boolean
  wasStreaming: boolean
  reason: string
}

export interface RpcRuntimeCallbacks {
  onEvent: (event: RpcObject) => void
  onStateChange: (patch: {
    isStreaming?: boolean
    isCompacting?: boolean
    sessionFile?: string | null
    modelProvider?: string | null
    modelId?: string | null
    thinkingLevel?: ThinkingLevel
    contextUsage?: ContextUsageInfo
    statusText?: string | null
  }) => void
  onExtensionUiRequest: (req: ExtensionUiRequest) => void
  onExit: (info: RpcRuntimeExitInfo) => void
}

function isRecord(value: unknown): value is RpcObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class RpcRuntime {
  readonly runtimeId = randomUUID()
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder: StrictJsonlDecoder
  private readonly chunks: RpcChunkAssembler
  private readonly pending = new Map<string, PendingRequest>()
  private writeChain: Promise<void> = Promise.resolve()
  private stderrTail = ''
  private stopped = false
  private closed = false
  private receivedFrame = false
  private isStreaming = false
  private isCompacting = false
  private statsInFlight = false
  private statsQueued = false
  private readonly bridge: ProtocolBridge | null = null
  private readonly bridgeCtx: BridgeContext | null = null

  constructor(
    readonly threadId: string,
    executable: string,
    args: string[],
    cwd: string,
    readonly adapter: HarnessRpcAdapter,
    private readonly callbacks: RpcRuntimeCallbacks,
    childEnv: NodeJS.ProcessEnv = safeChildEnvironment(),
    bridgeInfo?: BridgeStartInfo,
  ) {
    if (adapter.createBridge && bridgeInfo) {
      this.bridge = adapter.createBridge(bridgeInfo)
      this.bridgeCtx = {
        cwd,
        sessionPath: bridgeInfo.sessionPath ?? null,
        providerId: bridgeInfo.providerId ?? null,
        modelId: bridgeInfo.modelId ?? null,
        thinkingLevel: bridgeInfo.thinkingLevel ?? 'medium',
        writeLine: (line) => this.writeLine(line),
        respond: (id, data, error) => {
          const entry = this.pending.get(id)
          if (!entry) return
          this.pending.delete(id)
          clearTimeout(entry.timer)
          if (error !== undefined) {
            entry.reject(new Error(error))
          } else {
            entry.resolve({ type: 'response', id, command: entry.command, success: true, data: data ?? undefined })
          }
        },
        emit: (event) => this.dispatchNormalizedEvent(event),
        state: (patch) => {
          if (patch.isStreaming !== undefined) this.isStreaming = patch.isStreaming
          if (patch.isCompacting !== undefined) this.isCompacting = patch.isCompacting
          this.callbacks.onStateChange(patch)
        },
      }
    }
    this.chunks = new RpcChunkAssembler({
      agentName: adapter.agentName,
      deliver: (frame) => this.handleFrame(frame),
      emit: (ev) => this.callbacks.onEvent(ev),
      active: () => !this.stopped && !this.closed,
    })

    const invocation = prepareExecutableSpawn(executable, args, childEnv)
    this.child = spawn(invocation.file, invocation.args, {
      cwd,
      env: invocation.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })

    this.decoder = new StrictJsonlDecoder((line) => this.handleLine(line))

    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.decoder.push(chunk)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.callbacks.onEvent({ type: 'transport_error', error: msg })
        void this.stop()
      }
    })

    this.child.stdout.on('end', () => {
      try {
        this.decoder.end()
      } catch {
        // ignore trailing partial frame on process end
      }
    })

    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail += chunk.toString('utf8')
      if (this.stderrTail.length > 4096) {
        this.stderrTail = this.stderrTail.slice(-4096)
      }
    })

    this.child.stdin.on('error', () => {
      // broken pipe handled by close listener
    })

    this.child.once('error', (err) => {
      this.bridge?.dispose?.(err)
      this.failAllPending(err)
      this.callbacks.onEvent({ type: 'transport_error', error: err.message })
    })

    this.child.once('close', (code, signal) => {
      this.closed = true
      const unexpected = !this.stopped
      const wasStreaming = this.isStreaming || this.isCompacting
      this.isStreaming = false
      this.isCompacting = false
      this.chunks.close()
      const stderrSummary = this.stderrTail
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(' | ')
      const exitLabel = code !== null ? `退出码 ${code}` : signal ? `信号 ${signal}` : '进程连接中断'
      const reason = stderrSummary ? `${exitLabel}：${stderrSummary.slice(0, 260)}` : exitLabel
      const errMsg = !this.receivedFrame && code !== 0 && stderrSummary
        ? `${this.adapter.agentName} exited (${code ?? signal}): ${stderrSummary}`
        : `${this.adapter.agentName} process exited (${code ?? signal ?? 'closed'})`
      this.failAllPending(new Error(errMsg))
      this.bridge?.dispose?.(new Error(errMsg))
      this.callbacks.onEvent({ type: 'runtime_exit', code, signal, unexpected, wasStreaming, reason })
      this.callbacks.onExit({ code, signal, stderrTail: this.stderrTail, unexpected, wasStreaming, reason })
    })
  }

  get streaming(): boolean {
    return this.isStreaming
  }

  get compacting(): boolean {
    return this.isCompacting
  }

  get alive(): boolean {
    return !this.stopped && !this.closed
  }

  async handshake(): Promise<void> {
    if (this.bridge && this.bridgeCtx) {
      await this.bridge.initialize(this.bridgeCtx)
      await this.refreshState().catch(() => undefined)
      await this.refreshSessionStats().catch(() => undefined)
      return
    }
    if (this.adapter.negotiateProtocolVersion !== undefined) {
      await this.request(
        { type: 'negotiate_protocol', protocolVersion: this.adapter.negotiateProtocolVersion },
        30_000,
      )
    }
    await this.refreshState()
    await this.refreshSessionStats().catch(() => undefined)
  }

  async refreshState(): Promise<void> {
    const res = await this.request({ type: 'get_state' }, 15_000)
    const data = isRecord(res.data) ? res.data : null
    if (!data) return
    const reading = this.adapter.readState(data)
    const model = isRecord(data.model) ? data.model : null
    this.isStreaming = data.isStreaming === true
    this.isCompacting = data.isCompacting === true
    this.callbacks.onStateChange({
      isStreaming: this.isStreaming,
      isCompacting: this.isCompacting,
      sessionFile: typeof data.sessionFile === 'string' ? data.sessionFile : undefined,
      modelProvider: model && typeof model.provider === 'string' ? model.provider : undefined,
      modelId: model && typeof model.id === 'string' ? model.id : undefined,
      thinkingLevel: typeof data.thinkingLevel === 'string' ? (data.thinkingLevel as ThinkingLevel) : undefined,
      contextUsage: reading.contextUsage,
    })
  }

  async refreshSessionStats(): Promise<void> {
    if (!this.alive) return
    if (this.statsInFlight) {
      this.statsQueued = true
      return
    }
    this.statsInFlight = true
    try {
      do {
        this.statsQueued = false
        const res = await this.request({ type: 'get_session_stats' }, 8_000)
        const data = isRecord(res.data) ? res.data : null
        const usage = data ? parseContextUsage(data.contextUsage) : undefined
        if (usage) {
          this.callbacks.onStateChange({ contextUsage: usage })
        }
      } while (this.statsQueued && this.alive)
    } catch {
      // ignore if harness does not expose stats yet
    } finally {
      this.statsInFlight = false
    }
  }

  async sendCommand(rawCommand: RpcObject, timeoutMs = 60_000): Promise<RpcObject> {
    const command = this.adapter.translateCommand(rawCommand)
    if (command.type === 'extension_ui_response') {
      if (this.bridge && this.bridgeCtx) {
        const { type: _type, ...response } = command
        this.bridge.handleUiResponse(response as unknown as ExtensionUiResponse, this.bridgeCtx)
      } else {
        await this.writeLine(`${JSON.stringify(command)}\n`)
      }
      return { type: 'response', command: 'extension_ui_response', success: true }
    }
    const response = await this.request(command, timeoutMs)
    if (
      command.type === 'set_model' ||
      command.type === 'set_thinking_level' ||
      command.type === 'prompt' ||
      command.type === 'fork' ||
      command.type === 'branch' ||
      command.type === 'clone'
    ) {
      void this.refreshState().catch(() => undefined)
    }
    return response
  }

  async respondExtensionUi(response: ExtensionUiResponse): Promise<void> {
    if (this.bridge && this.bridgeCtx) {
      this.bridge.handleUiResponse(response, this.bridgeCtx)
      return
    }
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.chunks.close()
    if (!this.closed) {
      if (this.isStreaming || this.isCompacting) {
        await Promise.race([
          this.request({ type: 'abort' }, 3_000).catch(() => undefined),
          new Promise<void>((r) => setTimeout(r, 2_000)),
        ])
      }
      try {
        this.child.stdin.end()
      } catch {
        // ignore
      }
      const exitedGracefully = await this.waitForClose(750)
      if (!exitedGracefully && this.child.pid) {
        await killProcessTree(this.child.pid)
      }
    }
    this.failAllPending(new Error('Runtime stopped'))
    this.bridge?.dispose?.(new Error('Runtime stopped'))
  }

  private waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true)
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => resolveWait(false), timeoutMs)
      timer.unref()
      this.child.once('close', () => {
        clearTimeout(timer)
        resolveWait(true)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    if (!this.alive || !this.child.stdin.writable) {
      return Promise.reject(new Error('Agent runtime is not writable'))
    }
    const op = this.writeChain
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolveWrite, rejectWrite) => {
            if (!this.alive || !this.child.stdin.writable) {
              rejectWrite(new Error('Agent runtime closed'))
              return
            }
            this.child.stdin.write(line, (err) => {
              if (err) rejectWrite(err)
              else resolveWrite()
            })
          }),
      )
    this.writeChain = op.catch(() => undefined)
    return op
  }

  private request(command: RpcObject, timeoutMs: number): Promise<RpcObject> {
    if (!this.alive) return Promise.reject(new Error('Agent runtime is not running'))
    const id = randomUUID()
    const commandType = String(command.type)
    const line = `${JSON.stringify({ ...command, id })}\n`

    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectReq(new Error(`RPC command ${commandType} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()

      this.pending.set(id, {
        command: commandType,
        resolve: resolveReq,
        reject: rejectReq,
        timer,
      })

      const dispatch = this.bridge && this.bridgeCtx
        ? Promise.resolve(this.bridge.encodeCommand({ ...command, id }, this.bridgeCtx))
        : this.writeLine(line)
      void dispatch.catch((err) => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.callbacks.onEvent({
        type: 'transport_limit',
        error: `${this.adapter.agentName} emitted malformed JSON`,
      })
      return
    }
    this.handleFrame(parsed)
  }

  private handleFrame(raw: unknown): void {
    if (!isRecord(raw)) return
    this.receivedFrame = true

    if (this.bridge && this.bridgeCtx) {
      this.bridge.handleFrame(raw, this.bridgeCtx)
      return
    }

    if (typeof raw.type !== 'string') return

    if (raw.type === 'response' && typeof raw.id === 'string') {
      const entry = this.pending.get(raw.id)
      if (!entry) return
      this.pending.delete(raw.id)
      clearTimeout(entry.timer)
      if (raw.success !== true) {
        const errText = typeof raw.error === 'string' ? raw.error : `RPC command ${entry.command} failed`
        entry.reject(new Error(errText))
      } else {
        entry.resolve(raw)
      }
      return
    }

    if (this.adapter.chunkedFrames && raw.type === 'rpc_chunk') {
      this.chunks.accept(raw)
      return
    }

    const normalized = this.adapter.normalizeEvent(raw)
    if (!normalized) return
    const list = Array.isArray(normalized) ? normalized : [normalized]
    for (const ev of list) {
      this.dispatchNormalizedEvent(ev)
    }
  }

  private dispatchNormalizedEvent(ev: RpcObject): void {
    const type = String(ev.type ?? '')

    if (type === 'extension_ui_request') {
      const method = typeof ev.method === 'string' ? ev.method : ''
      if (method === 'dismiss' && typeof ev.id === 'string') {
        this.callbacks.onExtensionUiRequest({
          id: ev.id,
          threadId: this.threadId,
          method: 'confirm',
          title: '',
          dismissed: true,
        })
        return
      }
      if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
        const id = typeof ev.id === 'string' ? ev.id : randomUUID()
        this.callbacks.onExtensionUiRequest({
          id,
          threadId: this.threadId,
          method,
          title: typeof ev.title === 'string' ? ev.title : '需要确认',
          message: typeof ev.message === 'string' ? ev.message : undefined,
          command: typeof ev.command === 'string' ? ev.command : undefined,
          options: Array.isArray(ev.options) ? ev.options.filter((o): o is string => typeof o === 'string') : undefined,
          placeholder: typeof ev.placeholder === 'string' ? ev.placeholder : undefined,
          prefill: typeof ev.prefill === 'string' ? ev.prefill : undefined,
          timeout: typeof ev.timeout === 'number' ? ev.timeout : undefined,
        })
        return
      }
      if (method === 'setStatus') {
        const text = typeof ev.statusText === 'string' ? ev.statusText : null
        this.callbacks.onStateChange({ statusText: text })
        return
      }
    }

    if (type === 'agent_start') {
      this.isStreaming = true
      this.callbacks.onStateChange({ isStreaming: true, isCompacting: false })
    } else if (type === 'agent_end' || type === 'agent_settled') {
      this.isStreaming = false
      this.callbacks.onStateChange({ isStreaming: false, isCompacting: false })
      void this.refreshSessionStats()
    } else if (type === 'compaction_start') {
      this.isCompacting = true
      this.callbacks.onStateChange({ isCompacting: true })
    } else if (type === 'compaction_end') {
      this.isCompacting = false
      this.callbacks.onStateChange({ isCompacting: false })
      void this.refreshSessionStats()
    } else if (type === 'message_end' || type === 'tool_execution_end') {
      void this.refreshSessionStats()
    } else if (type === 'thinking_level_changed' && typeof ev.level === 'string') {
      this.callbacks.onStateChange({ thinkingLevel: ev.level as ThinkingLevel })
    }

    this.callbacks.onEvent(ev)
  }
}
