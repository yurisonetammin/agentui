import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  GitBranch,
  Minimize2,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { applyRpcEventToTimeline } from '@shared/event-reducer'
import { matchGlobalShortcut } from '@shared/shortcuts'
import { dequeueUiRequest, enqueueUiRequest, pruneUiRequestsForThread } from '@shared/ui-queue'
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  THINKING_LEVELS,
  type CliSessionSummary,
  type ContextUsageInfo,
  type ExtensionUiRequest,
  type GitStatusSummary,
  type HarnessId,
  type HarnessStatus,
  type ModelCatalogResult,
  type ProjectEntry,
  type RuntimeDisconnectInfo,
  type ThinkingLevel,
  type ThreadEntry,
  type TimelineItem,
} from '@shared/types'
import { DiffPanel } from './components/DiffPanel'
import { ExtensionUiModal } from './components/ExtensionUiModal'
import { MarkdownView } from './components/MarkdownView'
import { SettingsModal } from './components/SettingsModal'
import { ShortcutsModal } from './components/ShortcutsModal'
import { Sidebar } from './components/Sidebar'
import { ThinkingBlock } from './components/ThinkingBlock'
import { ToolCallCard } from './components/ToolCallCard'

export function App() {
  const [harnesses, setHarnesses] = useState<Record<HarnessId, HarnessStatus>>({
    pi: { id: 'pi', name: 'Pi', path: null, version: null, ready: false, agentDir: '', sessionRoot: '' },
    omp: { id: 'omp', name: 'OMP', path: null, version: null, ready: false, agentDir: '', sessionRoot: '' },
    prime: { id: 'prime', name: 'Prime Agent', path: null, version: null, ready: false, agentDir: '', sessionRoot: '' },
  })
  const [customPaths, setCustomPaths] = useState<Partial<Record<HarnessId, string>>>({})
  const [activeHarness, setActiveHarness] = useState<HarnessId>('pi')
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [threads, setThreads] = useState<ThreadEntry[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [timelines, setTimelines] = useState<Record<string, TimelineItem[]>>({})
  const [contextUsages, setContextUsages] = useState<Record<string, ContextUsageInfo>>({})
  const [catalogs, setCatalogs] = useState<Partial<Record<HarnessId, ModelCatalogResult>>>({})
  const [cliSessions, setCliSessions] = useState<CliSessionSummary[]>([])
  const [gitStatus, setGitStatus] = useState<GitStatusSummary | null>(null)
  const [showDiffPanel, setShowDiffPanel] = useState(true)
  const [diffPanelTab, setDiffPanelTab] = useState<'changes' | 'worktrees'>('changes')
  const [showSettings, setShowSettings] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [pendingUiQueue, setPendingUiQueue] = useState<ExtensionUiRequest[]>([])
  const [statusTexts, setStatusTexts] = useState<Record<string, string | null>>({})
  const [disconnectInfos, setDisconnectInfos] = useState<Record<string, RuntimeDisconnectInfo | null>>({})
  const [dismissedDisconnectAt, setDismissedDisconnectAt] = useState<Record<string, number>>({})
  const [showStderrDetail, setShowStderrDetail] = useState(false)
  const [reconnectingThreadId, setReconnectingThreadId] = useState<string | null>(null)
  const [promptText, setPromptText] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const timelineEndRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const filterInputRef = useRef<HTMLInputElement | null>(null)

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  )

  const activeProject = useMemo(
    () => projects.find((p) => p.id === (activeThread?.projectId ?? activeProjectId)) ?? null,
    [projects, activeThread, activeProjectId],
  )

  const effectiveHarness: HarnessId = activeThread?.harness ?? activeHarness
  const activeCatalog = catalogs[effectiveHarness]
  const activeTimeline = activeThread ? timelines[activeThread.id] ?? [] : []
  const isStreaming =
    activeThread?.status === 'streaming' ||
    activeThread?.status === 'starting' ||
    activeThread?.status === 'compacting'

  const refreshGit = useCallback(async (cwd?: string) => {
    if (!cwd) {
      setGitStatus(null)
      return
    }
    const status = await window.agentui.gitGetStatus(cwd).catch(() => null)
    setGitStatus(status)
  }, [])

  const loadModelCatalog = useCallback(async (harness: HarnessId, refresh = false) => {
    const res = await window.agentui.getModelCatalog(harness, refresh)
    setCatalogs((prev) => ({ ...prev, [harness]: res }))
  }, [])

  useEffect(() => {
    void (async () => {
      const [state, hStatuses] = await Promise.all([
        window.agentui.getState(),
        window.agentui.discoverHarnesses(true),
      ])
      setProjects(state.projects)
      setThreads(state.threads)
      setCustomPaths(state.customBinaryPaths)
      setActiveHarness(state.activeHarness)
      setActiveProjectId(state.activeProjectId)
      setActiveThreadId(state.activeThreadId)
      setHarnesses(hStatuses)

      const firstReady = HARNESS_IDS.find((id) => hStatuses[id]?.ready)
      if (!hStatuses[state.activeHarness]?.ready && firstReady) {
        setActiveHarness(firstReady)
        void window.agentui.setActiveHarness(firstReady)
      }
      for (const id of HARNESS_IDS) {
        if (hStatuses[id]?.ready) void loadModelCatalog(id, false)
      }
    })()
  }, [loadModelCatalog])

  useEffect(() => {
    if (!activeThread) {
      setGitStatus(null)
      return
    }
    if (!timelines[activeThread.id]) {
      const targetId = activeThread.id
      void window.agentui.getThreadTimeline(targetId).then((items) => {
        setTimelines((prev) => ((prev[targetId]?.length ?? 0) > 0 ? prev : { ...prev, [targetId]: items }))
      })
    }
    void refreshGit(activeThread.cwd)
  }, [activeThread?.id, activeThread?.cwd, refreshGit])

  useEffect(() => {
    const unsubEvent = window.agentui.onThreadEvent(({ threadId, event }) => {
      setTimelines((prev) => ({
        ...prev,
        [threadId]: applyRpcEventToTimeline(prev[threadId] ?? [], event),
      }))
      const type = String(event.type ?? '')
      if (type === 'runtime_exit') {
        setPendingUiQueue((prev) => pruneUiRequestsForThread(prev, threadId))
      }
      if ((type === 'tool_execution_end' || type === 'agent_end' || type === 'agent_settled') && threadId === activeThreadId) {
        if (activeThread?.cwd) void refreshGit(activeThread.cwd)
      }
    })

    const unsubStatus = window.agentui.onThreadStatus((update) => {
      setThreads((prev) =>
        prev.map((t) =>
          t.id === update.threadId
            ? {
                ...t,
                status: update.status,
                title: update.title ?? t.title,
                sessionPath: update.sessionPath !== undefined ? update.sessionPath : t.sessionPath,
                lastError: update.lastError !== undefined ? update.lastError : t.lastError,
                modelProvider: update.modelProvider !== undefined ? update.modelProvider : t.modelProvider,
                modelId: update.modelId !== undefined ? update.modelId : t.modelId,
                thinkingLevel: update.thinkingLevel ?? t.thinkingLevel,
              }
            : t,
        ),
      )
      if (update.contextUsage) {
        setContextUsages((prev) => ({ ...prev, [update.threadId]: update.contextUsage! }))
      }
      if (update.statusText !== undefined) {
        setStatusTexts((prev) => ({ ...prev, [update.threadId]: update.statusText ?? null }))
      }
      if (update.disconnectInfo !== undefined) {
        setDisconnectInfos((prev) => ({ ...prev, [update.threadId]: update.disconnectInfo ?? null }))
        if (update.disconnectInfo === null) {
          setDismissedDisconnectAt((prev) => {
            if (!(update.threadId in prev)) return prev
            const copy = { ...prev }
            delete copy[update.threadId]
            return copy
          })
        }
      }
    })

    const unsubUi = window.agentui.onExtensionUiRequest((req) => {
      setPendingUiQueue((prev) => enqueueUiRequest(prev, req))
    })

    return () => {
      unsubEvent()
      unsubStatus()
      unsubUi()
    }
  }, [activeThreadId, activeThread?.cwd, refreshGit])

  useEffect(() => {
    setShowStderrDetail(false)
  }, [activeThreadId])

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [activeTimeline, activeThreadId])

  async function handleAddProject() {
    setActionError(null)
    const dir = await window.agentui.pickDirectory()
    if (!dir) return
    try {
      const proj = await window.agentui.addProject(dir)
      setProjects((prev) => (prev.some((p) => p.id === proj.id) ? prev : [...prev, proj]))
      setActiveProjectId(proj.id)
      const created = await window.agentui.createThread({ projectId: proj.id, harness: activeHarness })
      setThreads((prev) => [created, ...prev])
      setActiveThreadId(created.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleNewThread(projectId: string, harness: HarnessId, cwdOverride?: string, worktreeBranch?: string) {
    setActionError(null)
    try {
      const created = await window.agentui.createThread({
        projectId,
        harness,
        cwd: cwdOverride,
        worktreeBranch,
      })
      setThreads((prev) => [created, ...prev])
      setActiveThreadId(created.id)
      setActiveProjectId(projectId)
      setActiveHarness(harness)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSwitchComposerHarness(nextHarness: HarnessId) {
    setActiveHarness(nextHarness)
    void window.agentui.setActiveHarness(nextHarness)
    if (!catalogs[nextHarness]) void loadModelCatalog(nextHarness, false)

    if (!activeProject) return
    if (
      activeThread &&
      activeThread.status === 'idle' &&
      !activeThread.sessionPath &&
      (timelines[activeThread.id]?.length ?? 0) === 0
    ) {
      try {
        const updated = await window.agentui.updateThreadMeta(activeThread.id, { harness: nextHarness })
        setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    // Bind a fresh session cleanly to the selected engine without interrupting running threads
    await handleNewThread(
      activeProject.id,
      nextHarness,
      activeThread?.cwd ?? activeProject.path,
      activeThread?.worktreeBranch ?? undefined,
    )
  }

  async function handleSend(behavior?: 'steer' | 'followUp') {
    if (!promptText.trim()) return
    setActionError(null)

    let targetThread = activeThread
    if (!targetThread) {
      if (!activeProject) {
        setActionError('请先在左侧添加一个本地项目目录')
        return
      }
      targetThread = await window.agentui.createThread({ projectId: activeProject.id, harness: activeHarness })
      setThreads((prev) => [targetThread!, ...prev])
      setActiveThreadId(targetThread.id)
    }

    const msg = promptText
    setPromptText('')

    if (!isStreaming) {
      setTimelines((prev) => ({
        ...prev,
        [targetThread!.id]: [
          ...(prev[targetThread!.id] ?? []),
          { id: `opt-${Date.now()}`, role: 'user', text: msg.trim(), timestamp: Date.now() },
        ],
      }))
    }

    try {
      await window.agentui.sendPrompt({
        threadId: targetThread.id,
        message: msg,
        streamingBehavior: behavior,
      })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleResumeCliSession(session: CliSessionSummary) {
    setActionError(null)
    try {
      let proj = projects.find((p) => p.path.toLowerCase() === session.cwd.toLowerCase())
      if (!proj && session.cwd) {
        proj = await window.agentui.addProject(session.cwd)
        setProjects((prev) => (prev.some((p) => p.id === proj!.id) ? prev : [...prev, proj!]))
      }
      if (!proj) {
        setActionError(`无法恢复会话：找不到工作目录 ${session.cwd}`)
        return
      }
      const created = await window.agentui.createThread({
        projectId: proj.id,
        harness: session.harness,
        title: session.title,
        cwd: session.cwd || proj.path,
        sessionPath: session.sessionPath,
      })
      setThreads((prev) => [created, ...prev])
      setActiveThreadId(created.id)
      setActiveProjectId(proj.id)
      const items = await window.agentui.getThreadTimeline(created.id)
      setTimelines((prev) => ({ ...prev, [created.id]: items }))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleReconnect(threadId: string) {
    setActionError(null)
    setReconnectingThreadId(threadId)
    try {
      await window.agentui.reconnectThread(threadId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnectingThreadId((cur) => (cur === threadId ? null : cur))
    }
  }

  async function handleRetryLastPrompt(threadId: string, promptToRetry: string) {
    setActionError(null)
    setReconnectingThreadId(threadId)
    setTimelines((prev) => ({
      ...prev,
      [threadId]: [
        ...(prev[threadId] ?? []),
        { id: `opt-retry-${Date.now()}`, role: 'user', text: promptToRetry.trim(), timestamp: Date.now() },
      ],
    }))
    try {
      await window.agentui.retryLastPrompt(threadId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnectingThreadId((cur) => (cur === threadId ? null : cur))
    }
  }

  const lastUserPromptInTimeline = useMemo(() => {
    for (let i = activeTimeline.length - 1; i >= 0; i -= 1) {
      const item = activeTimeline[i]
      if (item.role === 'user' && item.text.trim()) return item.text
    }
    return null
  }, [activeTimeline])

  const currentModelValue =
    activeThread?.modelProvider && activeThread?.modelId
      ? `${activeThread.modelProvider}::${activeThread.modelId}`
      : ''

  const currentCtxUsage = activeThread ? contextUsages[activeThread.id] : undefined
  const currentStatusText = activeThread ? statusTexts[activeThread.id] : null
  const activePendingUi = pendingUiQueue[0] ?? null
  const activePendingThread = activePendingUi
    ? threads.find((t) => t.id === activePendingUi.threadId) ?? null
    : null

  const activeDisconnectInfo = activeThread ? disconnectInfos[activeThread.id] ?? null : null
  const disconnectReason = activeDisconnectInfo?.reason ?? activeThread?.lastError ?? null
  const disconnectMarker = activeDisconnectInfo?.disconnectedAt ?? (activeThread?.updatedAt ?? 0)
  const retryPromptCandidate = activeDisconnectInfo?.lastPrompt || lastUserPromptInTimeline
  const showDisconnectBanner = Boolean(
    activeThread &&
      (activeThread.status === 'disconnected' || activeThread.status === 'error') &&
      disconnectReason &&
      dismissedDisconnectAt[activeThread.id] !== disconnectMarker,
  )

  const shortcutCtxRef = useRef<{
    onShortcut: (action: ReturnType<typeof matchGlobalShortcut>, e: KeyboardEvent) => void
  }>({ onShortcut: () => undefined })

  shortcutCtxRef.current.onShortcut = (action, e) => {
    if (!action) return
    const targetEl = e.target as HTMLElement | null

    if (action === 'escape') {
      if (targetEl?.classList?.contains('inline-rename-input')) return
      if (showShortcuts) {
        e.preventDefault()
        setShowShortcuts(false)
        return
      }
      if (showSettings) {
        e.preventDefault()
        setShowSettings(false)
        return
      }
      if (activePendingUi) return
      if (isStreaming && activeThread) {
        e.preventDefault()
        void window.agentui
          .abortThread(activeThread.id)
          .then(() => {
            setPendingUiQueue((prev) => pruneUiRequestsForThread(prev, activeThread.id))
          })
          .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      }
      return
    }

    if (activePendingUi) return

    e.preventDefault()
    if (action === 'new-thread') {
      if (activeProject) {
        void handleNewThread(activeProject.id, effectiveHarness)
      } else {
        void handleAddProject()
      }
    } else if (action === 'focus-filter') {
      filterInputRef.current?.focus()
      filterInputRef.current?.select()
    } else if (action === 'focus-composer') {
      composerRef.current?.focus()
    } else if (action === 'toggle-diff') {
      setShowDiffPanel((v) => !v)
    } else if (action === 'open-worktrees') {
      setDiffPanelTab('worktrees')
      setShowDiffPanel(true)
    } else if (action === 'switch-pi') {
      void handleSwitchComposerHarness('pi')
    } else if (action === 'switch-omp') {
      void handleSwitchComposerHarness('omp')
    } else if (action === 'switch-prime') {
      void handleSwitchComposerHarness('prime')
    } else if (action === 'toggle-settings') {
      setShowShortcuts(false)
      setShowSettings((v) => !v)
    } else if (action === 'toggle-shortcuts') {
      setShowSettings(false)
      setShowShortcuts((v) => !v)
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = matchGlobalShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        isComposing: e.isComposing,
      })
      if (action) shortcutCtxRef.current.onShortcut(action, e)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app-shell">
      <Sidebar
        harnesses={harnesses}
        activeHarness={effectiveHarness}
        projects={projects}
        threads={threads}
        activeProjectId={activeProject?.id ?? null}
        activeThreadId={activeThreadId}
        cliSessions={cliSessions}
        onSelectHarness={(id) => void handleSwitchComposerHarness(id)}
        onRefreshHarnesses={() =>
          void window.agentui.discoverHarnesses(true).then((res) => {
            setHarnesses(res)
            for (const id of HARNESS_IDS) {
              if (res[id]?.ready) void loadModelCatalog(id, true)
            }
          })
        }
        onOpenShortcuts={() => setShowShortcuts(true)}
        onOpenSettings={() => setShowSettings(true)}
        filterInputRef={filterInputRef}
        onAddProject={() => void handleAddProject()}
        onRemoveProject={(id) => {
          const removedIds = new Set(threads.filter((t) => t.projectId === id).map((t) => t.id))
          void window.agentui
            .removeProject(id)
            .then(() => {
              setProjects((prev) => prev.filter((p) => p.id !== id))
              setThreads((prev) => prev.filter((t) => t.projectId !== id))
              setPendingUiQueue((prev) => prev.filter((item) => !removedIds.has(item.threadId)))
            })
            .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
        }}
        onNewThread={(pid, harness) => void handleNewThread(pid, harness)}
        onSelectThread={(tid) => {
          setActiveThreadId(tid)
          void window.agentui.setActiveThread(tid)
        }}
        onDeleteThread={(tid) =>
          void window.agentui
            .deleteThread(tid)
            .then(() => {
              setThreads((prev) => prev.filter((t) => t.id !== tid))
              setPendingUiQueue((prev) => pruneUiRequestsForThread(prev, tid))
              if (activeThreadId === tid) setActiveThreadId(null)
            })
            .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
        }
        onRenameThread={(tid, title) =>
          void window.agentui
            .updateThreadMeta(tid, { title })
            .then((updated) => {
              setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
            })
            .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
        }
        onResumeCliSession={(s) => void handleResumeCliSession(s)}
        onRefreshCliSessions={() => void window.agentui.listCliSessions().then(setCliSessions)}
      />

      <main className="main-pane">
        <header className="topbar">
          <div className="topbar-left">
            <span className={`harness-tag tag-${effectiveHarness}`}>
              {HARNESS_LABELS[effectiveHarness]}
              {harnesses[effectiveHarness]?.version ? ` ${harnesses[effectiveHarness].version}` : ''}
            </span>
            <span className="topbar-title">{activeThread?.title ?? 'AgentUI 工作台'}</span>
            {activeThread?.cwd && (
              <span className="mono-chip" title={activeThread.cwd}>
                {activeThread.worktreeBranch ? `⎇ ${activeThread.worktreeBranch} · ` : ''}
                {activeThread.cwd}
              </span>
            )}
            {currentStatusText && (
              <span className="mono-chip status-chip" title={currentStatusText}>
                {currentStatusText}
              </span>
            )}
          </div>

          <div className="topbar-right">
            {currentCtxUsage && (
              <span className="mono-chip" title="上下文窗口使用量">
                {currentCtxUsage.tokens?.toLocaleString() ?? '?'} / {currentCtxUsage.contextWindow.toLocaleString()}
                {currentCtxUsage.percent !== null ? ` (${currentCtxUsage.percent}%)` : ''}
              </span>
            )}
            {activeThread && (
              <button
                type="button"
                className="btn-small"
                title="压缩当前上下文"
                onClick={() => void window.agentui.compactThread(activeThread.id).catch((e) => setActionError(String(e)))}
              >
                <Minimize2 size={12} />
                Compact
              </button>
            )}
            <button
              type="button"
              className="btn-small"
              title="展开 / 收起右侧 Diff 抽屉 (Ctrl+Shift+D)"
              onClick={() => setShowDiffPanel((v) => !v)}
            >
              <PanelRight size={13} />
              Diff / Worktree
            </button>
          </div>
        </header>

        <div className="timeline-scroll">
          {actionError && <div className="msg-notice error">{actionError}</div>}

          {!activeThread || activeTimeline.length === 0 ? (
            <div className="empty-state">
              <h2>Pi · OMP · Prime Agent 多引擎工作台</h2>
              <p>
                {activeThread
                  ? `当前会话绑定 ${HARNESS_LABELS[activeThread.harness]}，工作目录：${activeThread.cwd}`
                  : '在左侧添加项目并选择任意引擎（Pi / OMP / Prime Agent），即可开始流式对话与代码改动审阅。'}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                {HARNESS_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="btn-small"
                    onClick={() => void handleSwitchComposerHarness(id)}
                  >
                    <span className={`dot ${harnesses[id]?.ready ? 'dot-ready' : 'dot-missing'}`} />
                    使用 {HARNESS_LABELS[id]}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            activeTimeline.map((item) => {
              if (item.role === 'user') {
                return (
                  <div key={item.id} className="msg-user">
                    {item.text}
                  </div>
                )
              }
              if (item.role === 'notice') {
                return (
                  <div key={item.id} className={`msg-notice ${item.kind}`}>
                    {item.text}
                  </div>
                )
              }
              return (
                <div key={item.id} className="msg-assistant">
                  {item.parts.map((part, idx) => {
                    if (part.type === 'thinking') {
                      return <ThinkingBlock key={idx} text={part.text} streaming={item.streaming} />
                    }
                    if (part.type === 'tool') {
                      const tool = item.toolCalls[part.toolCallId]
                      if (!tool) return null
                      return <ToolCallCard key={part.toolCallId} tool={tool} />
                    }
                    return <MarkdownView key={idx} content={part.text} />
                  })}
                  {item.errorMessage && <div className="msg-notice error">{item.errorMessage}</div>}
                  <div className="msg-meta">
                    {item.streaming && <span>输出中...</span>}
                    {item.model && <span>{item.model}</span>}
                    {item.usage && (
                      <span>
                        tokens: {item.usage.totalTokens.toLocaleString()}
                        {item.usage.costTotal ? ` · $${item.usage.costTotal.toFixed(4)}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )
            })
          )}
          <div ref={timelineEndRef} />
        </div>

        {showDisconnectBanner && activeThread && disconnectReason && (
          <div className={`disconnect-banner ${activeThread.status === 'error' ? 'is-error' : ''}`}>
            <div className="disconnect-banner-top">
              <div className="disconnect-banner-info">
                {activeThread.status === 'error' ? (
                  <AlertTriangle size={16} color="var(--danger)" style={{ marginTop: 2, flexShrink: 0 }} />
                ) : (
                  <WifiOff size={16} color="var(--warning)" style={{ marginTop: 2, flexShrink: 0 }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div className="disconnect-banner-title">
                    {activeThread.status === 'error'
                      ? `${HARNESS_LABELS[activeThread.harness]} 启动 / 连接失败`
                      : `${HARNESS_LABELS[activeThread.harness]} 进程意外退出，连接已断开`}
                  </div>
                  <div className="disconnect-banner-reason">{disconnectReason}</div>
                </div>
              </div>
              <div className="disconnect-actions">
                {activeDisconnectInfo?.stderrTail && (
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => setShowStderrDetail((v) => !v)}
                  >
                    {showStderrDetail ? '收起日志' : '错误详情'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-small"
                  disabled={reconnectingThreadId === activeThread.id}
                  onClick={() => void handleReconnect(activeThread.id)}
                >
                  <RefreshCw size={12} className={reconnectingThreadId === activeThread.id ? 'spin' : undefined} />
                  {reconnectingThreadId === activeThread.id ? '重连中...' : '重新连接'}
                </button>
                {retryPromptCandidate && (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={reconnectingThreadId === activeThread.id}
                    title={`重连并重试：${retryPromptCandidate.slice(0, 80)}`}
                    onClick={() => void handleRetryLastPrompt(activeThread.id, retryPromptCandidate)}
                  >
                    <RotateCcw size={12} />
                    重试上一条指令
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  title="暂时忽略"
                  onClick={() =>
                    setDismissedDisconnectAt((prev) => ({
                      ...prev,
                      [activeThread.id]: disconnectMarker,
                    }))
                  }
                >
                  <X size={13} />
                </button>
              </div>
            </div>
            {showStderrDetail && activeDisconnectInfo?.stderrTail && (
              <pre className="disconnect-stderr">{activeDisconnectInfo.stderrTail}</pre>
            )}
          </div>
        )}

        <div className="composer-wrap">
          <div className="composer-box">
            <textarea
              ref={composerRef}
              className="composer-textarea"
              placeholder={
                activeThread
                  ? `向 ${HARNESS_LABELS[activeThread.harness]} 发送指令（Enter 发送，Shift+Enter 换行，Ctrl+Enter ${isStreaming ? 'Steer 引导' : '发送'}，Ctrl+/ 查看快捷键）...`
                  : '先添加项目或选择一个会话（Ctrl+N 新建，Ctrl+/ 查看快捷键）...'
              }
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void handleSend(isStreaming ? 'steer' : undefined)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend(isStreaming ? 'followUp' : undefined)
                  return
                }
                if (e.key === 'ArrowUp' && !promptText && lastUserPromptInTimeline) {
                  e.preventDefault()
                  setPromptText(lastUserPromptInTimeline)
                }
              }}
            />

            <div className="composer-toolbar">
              <div className="composer-controls">
                <select
                  className="select-pill"
                  title="切换引擎（将新建绑定该引擎的会话，不中断后台运行中的任务）"
                  value={effectiveHarness}
                  onChange={(e) => void handleSwitchComposerHarness(e.target.value as HarnessId)}
                >
                  {HARNESS_IDS.map((id) => (
                    <option key={id} value={id}>
                      {HARNESS_LABELS[id]} {harnesses[id]?.ready ? '' : '(未就绪)'}
                    </option>
                  ))}
                </select>

                <select
                  className="select-pill"
                  style={{ maxWidth: 220 }}
                  value={currentModelValue}
                  onChange={(e) => {
                    if (!activeThread || !e.target.value) return
                    const [provider, modelId] = e.target.value.split('::')
                    void window.agentui
                      .setThreadModel(activeThread.id, provider, modelId)
                      .then(() => {
                        setThreads((prev) =>
                          prev.map((t) =>
                            t.id === activeThread.id ? { ...t, modelProvider: provider, modelId } : t,
                          ),
                        )
                      })
                      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                  }}
                >
                  <option value="">默认模型 ({activeCatalog?.models.length ?? 0} 个可用)</option>
                  {(activeCatalog?.models ?? []).map((m) => (
                    <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>
                      {m.provider}/{m.id}
                    </option>
                  ))}
                </select>

                <select
                  className="select-pill"
                  value={activeThread?.thinkingLevel ?? 'medium'}
                  onChange={(e) => {
                    const level = e.target.value as ThinkingLevel
                    if (!activeThread) return
                    void window.agentui
                      .setThreadThinking(activeThread.id, level)
                      .then(() => {
                        setThreads((prev) =>
                          prev.map((t) => (t.id === activeThread.id ? { ...t, thinkingLevel: level } : t)),
                        )
                      })
                      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                  }}
                >
                  {THINKING_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      Thinking: {lvl}
                    </option>
                  ))}
                </select>

                {activeProject && (
                  <button
                    type="button"
                    className="btn-small"
                    title="在右侧打开 Worktree 创建面板 (Ctrl+Shift+W)"
                    onClick={() => {
                      setDiffPanelTab('worktrees')
                      setShowDiffPanel(true)
                    }}
                  >
                    <GitBranch size={12} />
                    Worktree
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                {isStreaming && activeThread && (
                  <>
                    <button
                      type="button"
                      className="btn-small"
                      disabled={!promptText.trim()}
                      title="打断并引导当前轮次 (Ctrl+Enter)"
                      onClick={() => void handleSend('steer')}
                    >
                      <Zap size={12} />
                      Steer
                    </button>
                    <button
                      type="button"
                      className="btn-small"
                      style={{ color: 'var(--danger)' }}
                      title="中止当前生成 (Esc)"
                      onClick={() =>
                        void window.agentui
                          .abortThread(activeThread.id)
                          .then(() => {
                            setPendingUiQueue((prev) => pruneUiRequestsForThread(prev, activeThread.id))
                          })
                          .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                      }
                    >
                      <Square size={12} />
                      停止
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!promptText.trim()}
                  onClick={() => void handleSend(isStreaming ? 'followUp' : undefined)}
                >
                  <Send size={13} />
                  {isStreaming ? '排队' : '发送'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {showDiffPanel && activeThread && (
        <DiffPanel
          cwd={activeThread.cwd}
          repoRoot={gitStatus?.repoRoot}
          status={gitStatus}
          activeTab={diffPanelTab}
          onTabChange={setDiffPanelTab}
          onRefresh={() => void refreshGit(activeThread.cwd)}
          onClose={() => setShowDiffPanel(false)}
          onCreateWorktreeThread={async (branchName, baseRef) => {
            if (!activeProject) return
            const wt = await window.agentui.gitCreateWorktree(activeProject.path, branchName, baseRef)
            await handleNewThread(activeProject.id, effectiveHarness, wt.path, wt.branch ?? branchName)
          }}
          onNewThreadInWorktree={async (wtPath, branch) => {
            if (!activeProject) return
            await handleNewThread(activeProject.id, effectiveHarness, wtPath, branch ?? undefined)
          }}
          onRemoveWorktree={async (wtPath) => {
            if (!activeProject) return
            await window.agentui.gitRemoveWorktree(activeProject.path, wtPath, false)
            await refreshGit(activeThread.cwd)
          }}
        />
      )}

      {activePendingUi && (
        <ExtensionUiModal
          key={activePendingUi.id}
          request={activePendingUi}
          threadTitle={activePendingThread?.title}
          harnessLabel={activePendingThread ? HARNESS_LABELS[activePendingThread.harness] : undefined}
          queueLength={pendingUiQueue.length}
          onRespond={(resp) => {
            const targetThreadId = activePendingUi.threadId
            setPendingUiQueue((prev) => dequeueUiRequest(prev, activePendingUi.id))
            void window.agentui
              .respondExtensionUi(targetThreadId, resp)
              .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          harnesses={harnesses}
          customPaths={customPaths}
          onSavePath={async (h, p) => {
            const next = await window.agentui.setCustomBinaryPath(h, p)
            setHarnesses(next)
            setCustomPaths((prev) => {
              const copy = { ...prev }
              if (p) copy[h] = p
              else delete copy[h]
              return copy
            })
            if (next[h]?.ready) await loadModelCatalog(h, true)
          }}
          onRefresh={async () => {
            const next = await window.agentui.discoverHarnesses(true)
            setHarnesses(next)
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}
