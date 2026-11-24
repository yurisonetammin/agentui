import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StartupIssue } from '@shared/diagnostics'
import { BUILTIN_SLASH_COMMANDS } from '@shared/composer-autocomplete'
import { applyRpcEventToTimeline } from '@shared/event-reducer'
import {
  assessToolRequest,
  decideApproval,
  deriveCommandPrefixPattern,
  extractToolName,
  isPermissionRuleAction,
  isPermissionRuleTarget,
  matchPermissionRules,
  pickSelectOption,
  TRUST_PRESET_LABELS,
  type PermissionRuleTarget,
  type ToolPermissionRule,
  type TrustPreset,
} from '@shared/tool-policy'
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  type ContextUsageInfo,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
  type ForkThreadInput,
  type ForkThreadResult,
  type HarnessId,
  type RuntimeDisconnectInfo,
  type SendPromptInput,
  type SessionForkMessage,
  type SessionTreeSnapshot,
  type SlashCommandDescriptor,
  type ThinkingLevel,
  type ThreadEntry,
  type ThreadEventEnvelope,
  type ThreadStatusUpdate,
  type TimelineItem,
} from '@shared/types'
import type { HarnessDiscoveryService } from '../discovery'
import type { GitService, GitTurnCapture } from '../git/git-service'
import { harnessChildEnvironment } from '../process-utils'
import { createForkedSessionFile, readSessionForkTree, readSessionTimeline } from '../sessions/catalog'
import type { StateStore } from '../store'
import { parseContextUsage, selectHarnessRpcAdapter } from './adapters'
import { CLAUDE_THINKING_TOKENS } from './bridges/claude'
import { RpcRuntime } from './runtime'

export interface ManagerListeners {
  onThreadEvent: (envelope: ThreadEventEnvelope) => void
  onThreadStatus: (update: ThreadStatusUpdate) => void
  onExtensionUiRequest: (req: ExtensionUiRequest) => void
}

export class RuntimeManager {
  private readonly startupIssues: StartupIssue[] = []
  private readonly runtimes = new Map<string, RpcRuntime>()
  private readonly startLocks = new Map<string, Promise<RpcRuntime>>()
  private readonly timelines = new Map<string, TimelineItem[]>()
  private readonly lastPrompts = new Map<string, string>()
  private readonly commandCache = new Map<string, SlashCommandDescriptor[]>()
  private readonly gitTurns = new Map<string, Promise<GitTurnCapture | null>>()
  private readonly turnDiffs = new Map<string, { threadId: string; diff: string }>()
  private readonly finalizingTurns = new Set<Promise<void>>()
  private readonly sessionRules = new Map<string, ToolPermissionRule[]>()

  constructor(
    private readonly store: StateStore,
    private readonly discovery: HarnessDiscoveryService,
    private readonly listeners: ManagerListeners,
    private readonly git?: Pick<GitService, 'beginTurn'>,
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

  getStartupIssues(): StartupIssue[] {
    return structuredClone(this.startupIssues)
  }

  getCachedTimeline(threadId: string): TimelineItem[] | undefined {
    return this.timelines.get(threadId)
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

  getTurnDiff(threadId: string, summaryId: string): string | null {
    const record = this.turnDiffs.get(summaryId)
    return record?.threadId === threadId ? record.diff : null
  }

  private beginGitTurn(thread: ThreadEntry): Promise<GitTurnCapture | null> | undefined {
    const existing = this.gitTurns.get(thread.id)
    if (existing || !this.git) return existing
    const pending = this.git.beginTurn(thread.cwd).catch(() => null)
    this.gitTurns.set(thread.id, pending)
    return pending
  }

  private async discardGitTurn(threadId: string): Promise<void> {
    const pending = this.gitTurns.get(threadId)
    this.gitTurns.delete(threadId)
    const capture = await pending
    await capture?.discard().catch(() => undefined)
  }

  private finishGitTurn(thread: ThreadEntry): void {
    const pending = this.gitTurns.get(thread.id)
    if (!pending) return
    this.gitTurns.delete(thread.id)
    const endedAt = Date.now()
    const finish: Promise<void> = pending.then(async (capture) => {
      const result = await capture?.finish()
      if (!result?.changes.files || !this.store.snapshot().threads.some((entry) => entry.id === thread.id)) return
      const id = `changes-${randomUUID()}`
      if (result.diff) {
        this.turnDiffs.set(id, { threadId: thread.id, diff: result.diff })
        if (this.turnDiffs.size > 24) this.turnDiffs.delete(this.turnDiffs.keys().next().value!)
      }
      const event = { type: 'git_turn_summary', id, endedAt, ...result.changes }
      this.updateTimeline(thread.id, event)
      this.listeners.onThreadEvent({ threadId: thread.id, harness: thread.harness, event })
    }).catch(() => undefined).finally(() => { this.finalizingTurns.delete(finish) })
    this.finalizingTurns.add(finish)
  }

  async sendPrompt(input: SendPromptInput): Promise<void> {
    const thread = this.getThreadOrThrow(input.threadId)
    const rawImages = (input.images ?? []).filter((img) => Boolean(img.data && img.mimeType))
    const message = input.message.trim() || (rawImages.length > 0 ? '请查看附带的图片' : '')
    if (!message && rawImages.length === 0) throw new Error('消息不能为空')
    this.lastPrompts.set(thread.id, message)

    const wireImages =
      rawImages.length > 0
        ? rawImages.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType }))
        : undefined

    const existing = this.runtimes.get(thread.id)
    if (existing?.alive && existing.streaming) {
      // Extension slash commands execute via `prompt` even during streaming; normal cues use steer/follow_up
      const cmdType = message.startsWith('/')
        ? 'prompt'
        : input.streamingBehavior === 'steer'
          ? 'steer'
          : 'follow_up'
      await existing.sendCommand({
        type: cmdType,
        message,
        ...(wireImages ? { images: wireImages } : {}),
      })
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
        images: rawImages.length > 0 ? rawImages : undefined,
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
    const baseline = this.beginGitTurn(thread)
    await baseline
    if (baseline && this.gitTurns.get(thread.id) !== baseline) return
    try {
      await runtime.sendCommand({
        type: 'prompt',
        message,
        ...(wireImages ? { images: wireImages } : {}),
      })
    } catch (error) {
      if (this.gitTurns.get(thread.id) === baseline) await this.discardGitTurn(thread.id)
      throw error
    }
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
    const before = this.store.snapshot().threads.find((t) => t.id === threadId)
    const previous = { modelProvider: before?.modelProvider ?? null, modelId: before?.modelId ?? null }
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
      try {
        await runtime.sendCommand({ type: 'set_model', provider, modelId }, 15_000)
      } catch (err) {
        // Engine rejected the switch: restore the persisted model so the UI matches reality.
        this.emitStatus(threadId, before?.status ?? 'idle', previous)
        throw err
      }
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

  async getSlashCommands(threadId: string): Promise<SlashCommandDescriptor[]> {
    const thread = this.store.snapshot().threads.find((t) => t.id === threadId)
    const merged: SlashCommandDescriptor[] = [...BUILTIN_SLASH_COMMANDS]
    if (!thread) return merged

    const cacheKey = `${thread.harness}::${thread.cwd.toLowerCase()}`
    const runtime = this.runtimes.get(threadId)
    if (runtime?.alive) {
      try {
        const res = await runtime.sendCommand({ type: 'get_commands' }, 5_000)
        const data = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null
        const rawList = Array.isArray(data?.commands) ? data.commands : []
        const discovered: SlashCommandDescriptor[] = []
        for (const entry of rawList) {
          if (!entry || typeof entry !== 'object') continue
          const rec = entry as Record<string, unknown>
          const name = typeof rec.name === 'string' ? rec.name.replace(/^\/+/, '').trim() : ''
          if (!name) continue
          const srcRaw = typeof rec.source === 'string' ? rec.source : 'extension'
          const source: SlashCommandDescriptor['source'] =
            srcRaw === 'prompt' || srcRaw === 'skill' || srcRaw === 'extension' ? srcRaw : 'extension'
          discovered.push({
            name,
            description: typeof rec.description === 'string' ? rec.description : undefined,
            source,
          })
        }
        this.commandCache.set(cacheKey, discovered)
      } catch {
        // Engine may not support get_commands; use cached or built-in list gracefully
      }
    }

    const extra = this.commandCache.get(cacheKey) ?? []
    const seen = new Set(merged.map((c) => c.name.toLowerCase()))
    for (const cmd of extra) {
      if (seen.has(cmd.name.toLowerCase())) continue
      seen.add(cmd.name.toLowerCase())
      merged.push(cmd)
    }
    return merged
  }

  async getForkTree(threadId: string): Promise<SessionTreeSnapshot> {
    const thread = this.getThreadOrThrow(threadId)
    const runtime = this.runtimes.get(threadId)
    if (!thread.sessionPath && runtime?.alive) {
      await runtime.refreshState().catch(() => undefined)
    }
    const latestThread = this.getThreadOrThrow(threadId)
    const snapshot = readSessionForkTree(latestThread.sessionPath)
    let supportsNativeFork = snapshot.supportsNativeFork

    if (runtime?.alive) {
      try {
        const res = await runtime.sendCommand({ type: 'get_fork_messages' }, 5_000)
        const data = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null
        const liveList = Array.isArray(data?.messages) ? data.messages : []
        if (liveList.length > 0) {
          supportsNativeFork = true
          const existingIds = new Set(snapshot.messages.map((m) => m.entryId))
          const merged: SessionForkMessage[] = [...snapshot.messages]
          for (const raw of liveList) {
            if (!raw || typeof raw !== 'object') continue
            const rec = raw as Record<string, unknown>
            const entryId = typeof rec.entryId === 'string' ? rec.entryId : ''
            const text = typeof rec.text === 'string' ? rec.text.trim() : ''
            if (!entryId || !text || existingIds.has(entryId)) continue
            existingIds.add(entryId)
            merged.push({
              entryId,
              parentId: merged[merged.length - 1]?.entryId ?? null,
              text,
              depth: merged.length,
            })
          }
          snapshot.messages = merged
        }
      } catch {
        // Fallback cleanly to disk session tree
      }
    }

    return {
      ...snapshot,
      supportsNativeFork,
    }
  }

  async forkThread(input: ForkThreadInput): Promise<ForkThreadResult> {
    let source = this.getThreadOrThrow(input.threadId)
    const activeRuntime = this.runtimes.get(source.id)
    if (!source.sessionPath && activeRuntime?.alive) {
      await activeRuntime.refreshState().catch(() => undefined)
      source = this.getThreadOrThrow(input.threadId)
    }

    if (input.mode === 'in-place') {
      const runtime = await this.ensureRuntime(source)
      const cmd = input.entryId ? { type: 'fork', entryId: input.entryId } : { type: 'clone' }
      const res = await runtime.sendCommand(cmd, 20_000)
      const data = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null
      if (data?.cancelled === true) {
        return { thread: source, cancelled: true }
      }
      await runtime.refreshState().catch(() => undefined)
      const updated = this.getThreadOrThrow(source.id)
      if (updated.sessionPath) {
        this.timelines.set(updated.id, readSessionTimeline(updated.sessionPath))
      }
      return {
        thread: updated,
        prefillText: typeof data?.text === 'string' ? data.text : undefined,
        cancelled: false,
      }
    }

    // Non-destructive new-thread fork (side-by-side comparison across same or different engines)
    if (!source.sessionPath) {
      throw new Error('当前会话尚未写入历史记录，请先完成至少一轮对话后再分叉')
    }
    const { sessionPath: forkedSessionPath, prefillText } = createForkedSessionFile(
      source.sessionPath,
      input.entryId ?? null,
    )
    const nextHarness = input.harness ?? source.harness
    const sameHarness = nextHarness === source.harness
    const now = Date.now()
    const baseTitle = source.title.replace(/\s*·\s*分叉.*$/, '').slice(0, 28)
    const suffix = input.entryId ? '分叉' : '克隆'
    const engineTag = sameHarness ? '' : `(${HARNESS_LABELS[nextHarness]})`
    const created: ThreadEntry = {
      id: randomUUID(),
      projectId: source.projectId,
      title: input.title?.trim() || `${baseTitle} · ${suffix}${engineTag}`,
      harness: nextHarness,
      cwd: source.cwd,
      worktreeBranch: source.worktreeBranch ?? null,
      sessionPath: forkedSessionPath,
      parentThreadId: source.id,
      forkedFromEntryId: input.entryId ?? null,
      modelProvider: sameHarness ? (source.modelProvider ?? null) : null,
      modelId: sameHarness ? (source.modelId ?? null) : null,
      thinkingLevel: source.thinkingLevel,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      lastError: null,
    }

    this.store.mutate((draft) => {
      draft.threads.unshift(created)
      draft.activeThreadId = created.id
      draft.activeProjectId = created.projectId
      draft.activeHarness = created.harness
    })
    this.timelines.set(created.id, readSessionTimeline(forkedSessionPath))
    return {
      thread: created,
      prefillText,
      cancelled: false,
    }
  }

  async stopThread(threadId: string): Promise<void> {
    const cleanup = this.discardGitTurn(threadId)
    const runtime = this.runtimes.get(threadId)
    if (runtime) {
      this.runtimes.delete(threadId)
      await runtime.stop()
    }
    await cleanup
  }

  isRuntimeAlive(threadId: string): boolean {
    return this.runtimes.get(threadId)?.alive ?? false
  }

  /**
   * 活跃会话的用量快照：向运行中的引擎请求 `get_session_stats`，
   * 用于「使用情况」页校验会话总量与展示上下文占用。不支持该命令的
   * 引擎（或进程未运行）返回 null。
   */
  async getSessionUsageSnapshot(threadId: string): Promise<ContextUsageInfo | null> {
    const runtime = this.runtimes.get(threadId)
    if (!runtime?.alive) return null
    try {
      const res = await runtime.sendCommand({ type: 'get_session_stats' }, 8_000)
      const data = res.data && typeof res.data === 'object' && !Array.isArray(res.data)
        ? (res.data as Record<string, unknown>)
        : null
      return data ? parseContextUsage(data.contextUsage) ?? null : null
    } catch {
      return null
    }
  }

  /** 指定引擎在项目目录下的运行中会话状态（MCP 生效判断）。 */
  getEngineSessionState(engine: 'pi' | 'omp' | 'prime', projectPath: string | null): { hasLiveSession: boolean; startedAt: number | null } {
    for (const [threadId, runtime] of this.runtimes) {
      if (!runtime.alive) continue
      const thread = this.store.snapshot().threads.find((t) => t.id === threadId)
      if (!thread || thread.harness !== engine) continue
      if (projectPath && thread.cwd !== projectPath) continue
      return { hasLiveSession: true, startedAt: runtime.startedAt }
    }
    return { hasLiveSession: false, startedAt: null }
  }

  addSessionRule(
    threadId: string,
    input: Omit<ToolPermissionRule, 'id' | 'createdAt'>,
  ): ToolPermissionRule[] {
    if (!isPermissionRuleAction(input.action) || !isPermissionRuleTarget(input.target)) {
      throw new Error('无效的会话权限规则')
    }
    const pattern = input.pattern.trim()
    if (!pattern || pattern.length > 200) throw new Error('规则模式不能为空且不超过 200 字符')
    const current = this.sessionRules.get(threadId) ?? []
    const dup = current.some(
      (r) =>
        r.action === input.action &&
        r.target === input.target &&
        r.pattern.toLowerCase() === pattern.toLowerCase(),
    )
    if (dup) return structuredClone(current)
    const next: ToolPermissionRule[] = [
      ...current,
      {
        id: `sess-${randomUUID().slice(0, 8)}`,
        action: input.action,
        target: input.target,
        pattern,
        note: input.note?.trim() || '本会话记住',
        createdAt: Date.now(),
      },
    ]
    this.sessionRules.set(threadId, next)
    return structuredClone(next)
  }

  getSessionRules(threadId: string): ToolPermissionRule[] {
    return structuredClone(this.sessionRules.get(threadId) ?? [])
  }

  clearSessionRules(threadId: string): void {
    this.sessionRules.delete(threadId)
  }

  /**
   * Run a short, side-effect-free one-shot prompt against an ephemeral RPC runtime
   * (e.g. for generating a Git commit message) without mutating any user thread or
   * leaving behind a stray CLI session file.
   */
  async generateOneShotText(prompt: string, preferredHarness?: HarnessId, timeoutMs = 20_000): Promise<string | null> {
    const snapshot = this.discovery.snapshot()
    const order: HarnessId[] = [
      ...(preferredHarness ? [preferredHarness] : []),
      ...HARNESS_IDS.filter((id) => id !== preferredHarness),
    ]
    const target = order.find((id) => snapshot[id]?.ready && snapshot[id]?.path)
    if (!target) return null
    const status = snapshot[target]
    if (!status.path) return null

    const tempCwd = mkdtempSync(join(tmpdir(), 'agentui-oneshot-'))
    let createdSessionFile: string | null = null
    let timeline: TimelineItem[] = []
    let runtime: RpcRuntime | null = null

    try {
      const adapter = selectHarnessRpcAdapter(
        target,
        target === 'prime' ? status.implementation : undefined,
      )
      const thinkingLevel: ThinkingLevel = 'off'
      const args = adapter.buildStartArgs({
        cwd: tempCwd,
        thinkingLevel,
        executablePath: status.path,
      })

      let resolveDone: (() => void) | null = null
      let rejectDone: ((err: Error) => void) | null = null
      const donePromise = new Promise<void>((res, rej) => {
        resolveDone = res
        rejectDone = rej
      })

      const childEnv =
        target === 'omp'
          ? harnessChildEnvironment('omp', status.agentDir)
          : target === 'prime'
            ? harnessChildEnvironment('prime', status.agentDir, { PRIME_AGENT_TELEMETRY: '0' })
            : target === 'claude'
              ? harnessChildEnvironment('claude', status.agentDir, {
                  MAX_THINKING_TOKENS: String(CLAUDE_THINKING_TOKENS.off),
                })
              : harnessChildEnvironment(target, status.agentDir)

      runtime = new RpcRuntime(
        `oneshot-${randomUUID().slice(0, 8)}`,
        status.path,
        args,
        tempCwd,
        adapter,
        {
          onEvent: (event) => {
            timeline = applyRpcEventToTimeline(timeline, event)
            const t = String(event.type ?? '')
            if (t === 'agent_end' || t === 'agent_settled') resolveDone?.()
            else if (t === 'error') rejectDone?.(new Error(String(event.error ?? 'one-shot error')))
          },
          onStateChange: (patch) => {
            if (patch.sessionFile && !/^(codex|acp|dsh):/.test(patch.sessionFile)) {
              createdSessionFile = patch.sessionFile
            }
          },
          onExtensionUiRequest: (req) => {
            if (req.dismissed || !runtime) return
            void runtime
              .respondExtensionUi({ id: req.id, confirmed: false, cancelled: true })
              .catch(() => undefined)
          },
          onExit: () => {
            resolveDone?.()
          },
        },
        childEnv,
        adapter.createBridge
          ? {
              cwd: tempCwd,
              thinkingLevel,
              executablePath: status.path,
              getTrustPreset: () => 'readonly',
            }
          : undefined,
      )

      const timer = setTimeout(() => rejectDone?.(new Error('AI 生成超时')), timeoutMs)
      timer.unref()
      try {
        await runtime.handshake()
        await runtime.sendCommand({ type: 'prompt', message: prompt }, Math.min(timeoutMs, 15_000))
        await donePromise
      } finally {
        clearTimeout(timer)
      }

      for (let i = timeline.length - 1; i >= 0; i -= 1) {
        const item = timeline[i]
        if (item.role !== 'assistant') continue
        const text = item.parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
          .trim()
        if (text) return text
      }
      return null
    } catch {
      return null
    } finally {
      if (runtime) await runtime.stop().catch(() => undefined)
      try { rmSync(tempCwd, { recursive: true, force: true }) } catch { /* ignore */ }
      if (createdSessionFile) {
        try { rmSync(createdSessionFile, { force: true }) } catch { /* ignore */ }
      }
    }
  }

  /**
   * Execute a scheduled background task inside `cwd` using the chosen engine/model
   * and trust preset. Unattended runs auto-allow only operations permitted by
   * `decideApproval` and auto-deny anything requiring interactive confirmation
   * or flagged as high risk so background jobs never stall or bypass safety.
   */
  async runScheduledPrompt(input: {
    cwd: string
    harness: HarnessId
    modelProvider?: string | null
    modelId?: string | null
    trustPreset: TrustPreset
    projectRules?: readonly ToolPermissionRule[]
    prompt: string
    timeoutMs?: number
  }): Promise<{ summary: string }> {
    const status = this.discovery.snapshot()[input.harness]
    if (!status?.ready || !status.path) {
      throw new Error(`引擎 ${input.harness} 未就绪，无法执行定时任务`)
    }
    const timeoutMs = input.timeoutMs ?? 120_000
    let createdSessionFile: string | null = null
    let timeline: TimelineItem[] = []
    let runtime: RpcRuntime | null = null

    try {
      const adapter = selectHarnessRpcAdapter(
        input.harness,
        input.harness === 'prime' ? status.implementation : undefined,
      )
      const thinkingLevel: ThinkingLevel = 'medium'
      const args = adapter.buildStartArgs({
        cwd: input.cwd,
        providerId: input.modelProvider ?? undefined,
        modelId: input.modelId ?? undefined,
        thinkingLevel,
        executablePath: status.path,
      })

      let resolveDone: (() => void) | null = null
      let rejectDone: ((err: Error) => void) | null = null
      const donePromise = new Promise<void>((res, rej) => {
        resolveDone = res
        rejectDone = rej
      })

      const childEnv =
        input.harness === 'omp'
          ? harnessChildEnvironment('omp', status.agentDir)
          : input.harness === 'prime'
            ? harnessChildEnvironment('prime', status.agentDir, { PRIME_AGENT_TELEMETRY: '0' })
            : input.harness === 'claude'
              ? harnessChildEnvironment('claude', status.agentDir, {
                  MAX_THINKING_TOKENS: String(CLAUDE_THINKING_TOKENS[thinkingLevel]),
                })
              : harnessChildEnvironment(input.harness, status.agentDir)

      runtime = new RpcRuntime(
        `sched-${randomUUID().slice(0, 8)}`,
        status.path,
        args,
        input.cwd,
        adapter,
        {
          onEvent: (event) => {
            timeline = applyRpcEventToTimeline(timeline, event)
            const t = String(event.type ?? '')
            if (t === 'agent_end' || t === 'agent_settled') resolveDone?.()
            else if (t === 'error') rejectDone?.(new Error(String(event.error ?? 'scheduled run error')))
          },
          onStateChange: (patch) => {
            if (patch.sessionFile && !/^(codex|acp|dsh):/.test(patch.sessionFile)) {
              createdSessionFile = patch.sessionFile
            }
          },
          onExtensionUiRequest: (req) => {
            if (req.dismissed || !runtime) return
            const assessment = assessToolRequest(req)
            const matchedRule = matchPermissionRules(input.projectRules ?? [], {
              title: req.title,
              message: req.message,
              command: assessment.command,
            })
            const decision = decideApproval(input.trustPreset, assessment, matchedRule)
            if (decision.action === 'allow' && (req.method === 'confirm' || req.method === 'select')) {
              const resp: ExtensionUiResponse =
                req.method === 'confirm'
                  ? { id: req.id, confirmed: true }
                  : { id: req.id, value: pickSelectOption(req.options ?? [], true) ?? undefined }
              if (req.method === 'confirm' || resp.value !== undefined) {
                void runtime.respondExtensionUi(resp).catch(() => undefined)
                return
              }
            }
            const denyResp: ExtensionUiResponse =
              req.method === 'select'
                ? (() => {
                    const opt = pickSelectOption(req.options ?? [], false)
                    return opt ? { id: req.id, value: opt } : { id: req.id, cancelled: true }
                  })()
                : { id: req.id, confirmed: false, cancelled: true }
            void runtime.respondExtensionUi(denyResp).catch(() => undefined)
          },
          onExit: (info) => {
            if (info.code && info.code !== 0) {
              rejectDone?.(new Error(`引擎进程退出 (${info.code})`))
            } else {
              resolveDone?.()
            }
          },
        },
        childEnv,
        adapter.createBridge
          ? {
              cwd: input.cwd,
              providerId: input.modelProvider ?? undefined,
              modelId: input.modelId ?? undefined,
              thinkingLevel,
              executablePath: status.path,
              getTrustPreset: () => input.trustPreset,
            }
          : undefined,
      )

      const timer = setTimeout(() => rejectDone?.(new Error(`定时任务执行超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)
      timer.unref()
      try {
        await runtime.handshake()
        await runtime.sendCommand({ type: 'prompt', message: input.prompt }, Math.min(timeoutMs, 20_000))
        await donePromise
      } finally {
        clearTimeout(timer)
      }

      for (let i = timeline.length - 1; i >= 0; i -= 1) {
        const item = timeline[i]
        if (item.role !== 'assistant') continue
        if (item.errorMessage) throw new Error(item.errorMessage)
        const text = item.parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
          .trim()
        if (text) return { summary: text.slice(0, 1_500) }
      }
      return { summary: '执行完成（无文本输出）' }
    } finally {
      if (runtime) await runtime.stop().catch(() => undefined)
      if (createdSessionFile) {
        try { rmSync(createdSessionFile, { force: true }) } catch { /* ignore */ }
      }
    }
  }

  async removeThread(threadId: string): Promise<void> {
    await this.stopThread(threadId)
    this.timelines.delete(threadId)
    this.lastPrompts.delete(threadId)
    this.sessionRules.delete(threadId)
    for (const [summaryId, record] of this.turnDiffs) {
      if (record.threadId === threadId) this.turnDiffs.delete(summaryId)
    }
  }

  async stopAll(): Promise<void> {
    const list = [...this.runtimes.values()]
    this.runtimes.clear()
    this.sessionRules.clear()
    await Promise.allSettled([
      ...list.map((r) => r.stop()),
      ...Array.from(this.gitTurns.keys(), (threadId) => this.discardGitTurn(threadId)),
      ...this.finalizingTurns,
    ])
  }

  private getThreadOrThrow(threadId: string): ThreadEntry {
    const thread = this.store.snapshot().threads.find((t) => t.id === threadId)
    if (!thread) throw new Error(`未找到会话 ${threadId}`)
    return thread
  }

  /**
   * Project trust-policy interception for engine approval prompts.
   * Only confirm/select requests are subject to the policy; input/editor always
   * reach the user. Note: engines that auto-execute tools without emitting an
   * approval request cannot be intercepted here (documented limitation).
   */
  private handleExtensionUiRequest(threadId: string, runtime: RpcRuntime, req: ExtensionUiRequest): void {
    const state = this.store.snapshot()
    const thread = state.threads.find((t) => t.id === threadId)
    const project = thread ? state.projects.find((p) => p.id === thread.projectId) : undefined
    const preset: TrustPreset = project?.trustPreset ?? 'approval'
    const harness = thread?.harness ?? 'pi'

    const forwardToUser = (enriched: ExtensionUiRequest) => {
      this.emitStatus(threadId, 'waiting_ui')
      this.listeners.onExtensionUiRequest(enriched)
    }

    if (req.dismissed) {
      // Engine withdrew the request: just tell the renderer to drop it.
      this.listeners.onExtensionUiRequest(req)
      return
    }

    if (req.method !== 'confirm' && req.method !== 'select') {
      forwardToUser({ ...req, policyPreset: preset })
      return
    }

    const assessment = assessToolRequest(req)
    const risk = { level: assessment.level, reasons: assessment.reasons, command: assessment.command }

    // Derive a safe one-click "remember in session / project" rule suggestion for non-high-risk approvals.
    let suggestedRule: { target: PermissionRuleTarget; pattern: string } | null = null
    if (assessment.level !== 'high') {
      const cmdPrefix = deriveCommandPrefixPattern(assessment.command)
      if (cmdPrefix) {
        suggestedRule = { target: 'command', pattern: cmdPrefix }
      } else {
        const extractedTool = extractToolName(req.title)
        if (extractedTool && /^[A-Za-z_][\w./-]{1,40}$/.test(extractedTool) && extractedTool !== req.title) {
          suggestedRule = { target: 'tool', pattern: extractedTool }
        }
      }
    }

    if (req.method === 'select') {
      const opts = req.options ?? []
      // Only treat select as an approval prompt when it offers recognisable allow/deny options;
      // ordinary extension menus (templates, branches, ...) always go to the user.
      const looksLikeApproval =
        pickSelectOption(opts, true) !== undefined || pickSelectOption(opts, false) !== undefined
      if (!looksLikeApproval) {
        forwardToUser({ ...req, policyPreset: preset, ...(req.command ? { risk } : {}) })
        return
      }
    }

    const combinedRules = [
      ...(project?.permissionRules ?? []),
      ...(this.sessionRules.get(threadId) ?? []),
    ]
    const matchedRule = matchPermissionRules(combinedRules, {
      title: req.title,
      message: req.message,
      command: assessment.command,
    })
    const decision = decideApproval(preset, assessment, matchedRule)

    if (decision.action === 'ask') {
      forwardToUser({ ...req, policyPreset: preset, risk, suggestedRule })
      return
    }

    const allow = decision.action === 'allow'
    let response: ExtensionUiResponse
    if (req.method === 'confirm') {
      response = { id: req.id, confirmed: allow }
    } else {
      const value = pickSelectOption(req.options ?? [], allow)
      if (value === undefined && allow) {
        // No unambiguous one-time allow option: let the human decide.
        forwardToUser({ ...req, policyPreset: preset, risk, suggestedRule })
        return
      }
      response = value !== undefined ? { id: req.id, value } : { id: req.id, cancelled: true }
    }
    runtime
      .respondExtensionUi(response)
      .then(() => {
        const noticeEvent: Record<string, unknown> = {
          type: 'extension_ui_request',
          method: 'notify',
          notifyType: allow ? 'info' : 'warning',
          message: `${TRUST_PRESET_LABELS[preset]}：${decision.reason}（${req.title}）`,
        }
        this.updateTimeline(threadId, noticeEvent)
        this.listeners.onThreadEvent({ threadId, harness, event: noticeEvent })
      })
      .catch(() => {
        // Auto-response failed (e.g. process died) — fall back to asking the user.
        forwardToUser({ ...req, policyPreset: preset, risk, suggestedRule })
      })
  }

  private emitStatus(threadId: string, status: ThreadEntry['status'], extra: Partial<ThreadStatusUpdate> = {}): void {
    const updatedAt = Date.now()
    this.store.mutate((draft) => {
      const t = draft.threads.find((item) => item.id === threadId)
      if (t) {
        t.status = status
        if (extra.sessionPath !== undefined) t.sessionPath = extra.sessionPath
        if (extra.lastError !== undefined) t.lastError = extra.lastError
        if (extra.modelProvider !== undefined) t.modelProvider = extra.modelProvider
        if (extra.modelId !== undefined) t.modelId = extra.modelId
        if (extra.thinkingLevel !== undefined) t.thinkingLevel = extra.thinkingLevel
        t.updatedAt = updatedAt
      }
    })
    this.listeners.onThreadStatus({ threadId, status, ...extra, updatedAt })
  }

  private ensureRuntime(thread: ThreadEntry): Promise<RpcRuntime> {
    const existing = this.runtimes.get(thread.id)
    if (existing?.alive) return Promise.resolve(existing)

    const inFlight = this.startLocks.get(thread.id)
    if (inFlight) return inFlight

    const promise = this.startRuntime(thread).catch((error: unknown) => {
      this.startupIssues.unshift({
        id: randomUUID(),
        harness: thread.harness,
        occurredAt: Date.now(),
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1500),
      })
      if (this.startupIssues.length > 12) this.startupIssues.pop()
      throw error
    }).finally(() => {
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
      executablePath: status.path,
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
          if (event.type === 'agent_start') this.beginGitTurn(thread)
          if (event.type === 'agent_end' || event.type === 'agent_settled' || event.type === 'runtime_exit') {
            this.finishGitTurn(thread)
          }
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
          this.handleExtensionUiRequest(thread.id, runtime, req)
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
          : thread.harness === 'claude'
            ? harnessChildEnvironment('claude', status.agentDir, {
                MAX_THINKING_TOKENS: String(CLAUDE_THINKING_TOKENS[thread.thinkingLevel] ?? CLAUDE_THINKING_TOKENS.medium),
              })
            : harnessChildEnvironment(thread.harness, status.agentDir),
      adapter.createBridge
        ? {
            cwd: thread.cwd,
            sessionPath: thread.sessionPath,
            providerId: thread.modelProvider,
            modelId: thread.modelId,
            thinkingLevel: thread.thinkingLevel,
            executablePath: status.path,
            getTrustPreset: () => {
              const snap = this.store.snapshot()
              const owner = snap.threads.find((t) => t.id === thread.id)
              const proj = owner ? snap.projects.find((p) => p.id === owner.projectId) : undefined
              return proj?.trustPreset ?? 'approval'
            },
          }
        : undefined,
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
