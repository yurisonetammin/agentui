import { applyRpcEventToTimeline } from '@shared/event-reducer'
import {
  HARNESS_LABELS,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
  type RuntimeDisconnectInfo,
  type SendPromptInput,
  type ThinkingLevel,
  type ThreadEntry,
  type ThreadEventEnvelope,
  type ThreadStatusUpdate,
  type TimelineItem,
} from '@shared/types'
import type { HarnessDiscoveryService } from '../discovery'
import { harnessChildEnvironment } from '../process-utils'
import { readSessionTimeline } from '../sessions/catalog'
import type { StateStore } from '../store'
import { selectHarnessRpcAdapter } from './adapters'
import { RpcRuntime } from './runtime'

export interface ManagerListeners {
  onThreadEvent: (envelope: ThreadEventEnvelope) => void
  onThreadStatus: (update: ThreadStatusUpdate) => void
  onExtensionUiRequest: (req: ExtensionUiRequest) => void
}

export class RuntimeManager {
  private readonly runtimes = new Map<string, RpcRuntime>()
  private readonly startLocks = new Map<string, Promise<RpcRuntime>>()
  private readonly timelines = new Map<string, TimelineItem[]>()
  private readonly lastPrompts = new Map<string, string>()

  constructor(
    private readonly store: StateStore,
    private readonly discovery: HarnessDiscoveryService,
    private readonly listeners: ManagerListeners,
  ) {}

  getLastUserPrompt(threadId: string): string | null {
    const tracked = this.lastPrompts.get(threadId)
    if (tracked && tracked.trim()) return tracked
    const timeline = this.getTimeline(threadId)
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const item = timeline[i]
      if (item.role === 'user' && item.text.trim()) {
        return item.text
      }
    }
    return null
  }

  getTimeline(threadId: string): TimelineItem[] {
    const cached = this.timelines.get(threadId)
    if (cached) return cached
    const thread = this.store.snapshot().threads.find((t) => t.id === threadId)
    if (thread?.sessionPath) {
      const loaded = readSessionTimeline(thread.sessionPath)
      this.timelines.set(threadId, loaded)
      return loaded
    }
    return []
  }

  private updateTimeline(threadId: string, event: Record<string, unknown>): void {
    const current = this.getTimeline(threadId)
    const next = applyRpcEventToTimeline(current, event)
    if (next !== current) {
      this.timelines.set(threadId, next)
    }
  }

  async sendPrompt(input: SendPromptInput): Promise<void> {
    const thread = this.getThreadOrThrow(input.threadId)
    const message = input.message.trim()
    if (!message) throw new Error('消息不能为空')
    this.lastPrompts.set(thread.id, message)

    const existing = this.runtimes.get(thread.id)
    if (existing?.alive && existing.streaming) {
      const cmdType = input.streamingBehavior === 'steer' ? 'steer' : 'follow_up'
      await existing.sendCommand({ type: cmdType, message })
      return
    }

    // Append optimistic user message & update title on first message
    const timeline = this.getTimeline(thread.id)
    const isFirst = timeline.length === 0
    this.timelines.set(thread.id, [
      ...timeline,
      {
        id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'user',
        text: message,
        timestamp: Date.now(),
      },
    ])
    if (isFirst) {
      const firstLine = message.split(/\r?\n/)[0].slice(0, 48)
      this.store.mutate((draft) => {
        const target = draft.threads.find((t) => t.id === thread.id)
        if (target && (target.title === '新对话' || !target.title)) {
          target.title = firstLine
          this.listeners.onThreadStatus({ threadId: thread.id, status: target.status, title: firstLine })
        }
        if (target) target.updatedAt = Date.now()
      })
    }

    const runtime = await this.ensureRuntime(thread)
    await runtime.sendCommand({ type: 'prompt', message })
  }

  async abort(threadId: string): Promise<void> {
    const runtime = this.runtimes.get(threadId)
    if (!runtime?.alive) return
    await runtime.sendCommand({ type: 'abort' }, 10_000)
  }

  async reconnect(threadId: string): Promise<void> {
    await this.stopThread(threadId)
    const thread = this.getThreadOrThrow(threadId)
    await this.ensureRuntime(thread)
    const refreshed = this.getThreadOrThrow(threadId)
    const noticeEvent: Record<string, unknown> = {
      type: 'extension_ui_request',
      method: 'notify',
      notifyType: 'info',
      message: `已重新连接 ${HARNESS_LABELS[refreshed.harness]} 进程${refreshed.sessionPath ? '并恢复上下文会话' : ''}。`,
    }
    this.updateTimeline(threadId, noticeEvent)
    this.listeners.onThreadEvent({ threadId, harness: refreshed.harness, event: noticeEvent })
  }

  async retryLastPrompt(threadId: string): Promise<void> {
    const lastPrompt = this.getLastUserPrompt(threadId)
    if (!lastPrompt) {
      throw new Error('当前会话没有可重试的上一条指令')
    }
    await this.sendPrompt({ threadId, message: lastPrompt })
  }

  async setModel(threadId: string, provider: string, modelId: string): Promise<void> {
    this.store.mutate((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)
      if (t) {
        t.modelProvider = provider
        t.modelId = modelId
        t.updatedAt = Date.now()
      }
    })
    const runtime = this.runtimes.get(threadId)
    if (runtime?.alive) {
      await runtime.sendCommand({ type: 'set_model', provider, modelId }, 15_000)
    }
  }

  async setThinkingLevel(threadId: string, level: ThinkingLevel): Promise<void> {
    this.store.mutate((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)
      if (t) {
        t.thinkingLevel = level
        t.updatedAt = Date.now()
      }
    })
    const runtime = this.runtimes.get(threadId)
    if (runtime?.alive) {
      await runtime.sendCommand({ type: 'set_thinking_level', level }, 15_000)
    }
  }

  async compact(threadId: string): Promise<void> {
    const thread = this.getThreadOrThrow(threadId)
    const runtime = await this.ensureRuntime(thread)
    await runtime.sendCommand({ type: 'compact' }, 120_000)
  }

  async respondExtensionUi(threadId: string, response: ExtensionUiResponse): Promise<void> {
    const runtime = this.runtimes.get(threadId)
    if (!runtime?.alive) throw new Error('Agent 进程未运行')
    await runtime.respondExtensionUi(response)
    this.emitStatus(threadId, runtime.streaming ? 'streaming' : 'idle')
  }

  async stopThread(threadId: string): Promise<void> {
    const runtime = this.runtimes.get(threadId)
    if (!runtime) return
    this.runtimes.delete(threadId)
    await runtime.stop()
  }

  async removeThread(threadId: string): Promise<void> {
    await this.stopThread(threadId)
    this.timelines.delete(threadId)
    this.lastPrompts.delete(threadId)
  }

  async stopAll(): Promise<void> {
    const list = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.allSettled(list.map((r) => r.stop()))
  }

  private getThreadOrThrow(threadId: string): ThreadEntry {
    const thread = this.store.snapshot().threads.find((t) => t.id === threadId)
    if (!thread) throw new Error(`未找到会话 ${threadId}`)
    return thread
  }

  private emitStatus(threadId: string, status: ThreadEntry['status'], extra: Partial<ThreadStatusUpdate> = {}): void {
    this.store.mutate((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)
      if (t) {
        t.status = status
        if (extra.sessionPath !== undefined) t.sessionPath = extra.sessionPath
        if (extra.lastError !== undefined) t.lastError = extra.lastError
        if (extra.modelProvider !== undefined) t.modelProvider = extra.modelProvider
        if (extra.modelId !== undefined) t.modelId = extra.modelId
        if (extra.thinkingLevel !== undefined) t.thinkingLevel = extra.thinkingLevel
        t.updatedAt = Date.now()
      }
    })
    this.listeners.onThreadStatus({ threadId, status, ...extra })
  }

  private ensureRuntime(thread: ThreadEntry): Promise<RpcRuntime> {
    const existing = this.runtimes.get(thread.id)
    if (existing?.alive) return Promise.resolve(existing)

    const inFlight = this.startLocks.get(thread.id)
    if (inFlight) return inFlight

    const promise = this.startRuntime(thread).finally(() => {
      this.startLocks.delete(thread.id)
    })
    this.startLocks.set(thread.id, promise)
    return promise
  }

  private async startRuntime(thread: ThreadEntry): Promise<RpcRuntime> {
    let statuses = this.discovery.snapshot()
    if (!statuses[thread.harness]?.ready || !statuses[thread.harness]?.path) {
      statuses = await this.discovery.refresh(this.store.snapshot().customBinaryPaths)
    }
    const status = statuses[thread.harness]
    if (!status.ready || !status.path) {
      const msg = status.error || `${status.name} 未就绪`
      const disconnectInfo: RuntimeDisconnectInfo = {
        code: null,
        signal: null,
        reason: msg,
        wasStreaming: false,
        lastPrompt: this.getLastUserPrompt(thread.id),
        disconnectedAt: Date.now(),
      }
      this.emitStatus(thread.id, 'error', { lastError: msg, disconnectInfo })
      throw new Error(msg)
    }

    const adapter = selectHarnessRpcAdapter(
      thread.harness,
      thread.harness === 'prime' ? status.implementation : undefined,
    )
    const args = adapter.buildStartArgs({
      cwd: thread.cwd,
      sessionPath: thread.sessionPath,
      providerId: thread.modelProvider,
      modelId: thread.modelId,
      thinkingLevel: thread.thinkingLevel,
    })

    this.emitStatus(thread.id, 'starting', { lastError: null, disconnectInfo: null })

    const runtime = new RpcRuntime(
      thread.id,
      status.path,
      args,
      thread.cwd,
      adapter,
      {
        onEvent: (event) => {
          this.updateTimeline(thread.id, event)
          this.listeners.onThreadEvent({ threadId: thread.id, harness: thread.harness, event })
        },
        onStateChange: (patch) => {
          const statusExplicit = patch.isStreaming !== undefined || patch.isCompacting !== undefined
          let nextStatus: ThreadEntry['status']
          if (statusExplicit) {
            const compacting = patch.isCompacting ?? runtime.compacting
            const streaming = patch.isStreaming ?? runtime.streaming
            nextStatus = compacting ? 'compacting' : streaming ? 'streaming' : 'idle'
          } else {
            const stored = this.store.snapshot().threads.find((t) => t.id === thread.id)?.status
            nextStatus =
              stored ?? (runtime.compacting ? 'compacting' : runtime.streaming ? 'streaming' : 'idle')
          }
          this.emitStatus(thread.id, nextStatus, {
            sessionPath: patch.sessionFile,
            modelProvider: patch.modelProvider,
            modelId: patch.modelId,
            thinkingLevel: patch.thinkingLevel,
            contextUsage: patch.contextUsage,
            statusText: patch.statusText,
          })
        },
        onExtensionUiRequest: (req) => {
          this.emitStatus(thread.id, 'waiting_ui')
          this.listeners.onExtensionUiRequest(req)
        },
        onExit: (info) => {
          if (this.runtimes.get(thread.id) === runtime) {
            this.runtimes.delete(thread.id)
          }
          if (!info.unexpected) {
            this.emitStatus(thread.id, 'idle', { statusText: null, disconnectInfo: null })
            return
          }
          const stderrSummary = info.stderrTail
            .trim()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(-6)
            .join('\n')
          const disconnectInfo: RuntimeDisconnectInfo = {
            code: info.code,
            signal: info.signal,
            reason: info.reason,
            stderrTail: stderrSummary || undefined,
            wasStreaming: info.wasStreaming,
            lastPrompt: this.getLastUserPrompt(thread.id),
            disconnectedAt: Date.now(),
          }
          this.emitStatus(thread.id, 'disconnected', {
            statusText: null,
            lastError: info.reason,
            disconnectInfo,
          })
        },
      },
      thread.harness === 'omp'
        ? harnessChildEnvironment('omp', status.agentDir)
        : thread.harness === 'prime'
          ? harnessChildEnvironment('prime', status.agentDir, { PRIME_AGENT_TELEMETRY: '0' })
          : harnessChildEnvironment('pi', status.agentDir),
    )

    this.runtimes.set(thread.id, runtime)
    try {
      await runtime.handshake()
      this.emitStatus(thread.id, 'idle', { lastError: null, disconnectInfo: null })
      return runtime
    } catch (err) {
      await runtime.stop().catch(() => undefined)
      this.runtimes.delete(thread.id)
      const msg = err instanceof Error ? err.message : String(err)
      const disconnectInfo: RuntimeDisconnectInfo = {
        code: null,
        signal: null,
        reason: msg,
        wasStreaming: false,
        lastPrompt: this.getLastUserPrompt(thread.id),
        disconnectedAt: Date.now(),
      }
      this.emitStatus(thread.id, 'error', { lastError: msg, disconnectInfo })
      throw err
    }
  }
}
