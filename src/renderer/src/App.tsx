import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCompareArrows,
  GitFork,
  ImagePlus,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Shield,
  Square,
  Terminal,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import {
  BUILTIN_SLASH_COMMANDS,
  applyTriggerInsertion,
  detectComposerTrigger,
  filterSlashCommands,
  parseBuiltinSlashCommand,
} from '@shared/composer-autocomplete'
import { applyRpcEventToTimeline } from '@shared/event-reducer'
import { matchGlobalShortcut, runningMessageAction } from '@shared/shortcuts'
import { DEFAULT_APPEARANCE, DEFAULT_CONVERSATION, THINKING_LABELS, type AppearanceSettings, type ConversationSettings, type HarnessDefaults } from '@shared/settings'
import { TRUST_PRESETS, TRUST_PRESET_LABELS, type TrustPreset } from '@shared/tool-policy'
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
  type ImageAttachment,
  type ModelCatalogResult,
  type ProjectEntry,
  type RuntimeDisconnectInfo,
  type SessionTreeSnapshot,
  type ShareToComposerEvent,
  type SlashCommandDescriptor,
  type ThinkingLevel,
  type ThreadEntry,
  type TimelineItem,
  type WorkspaceFileEntry,
} from '@shared/types'
import brandIcon from './assets/brand-icon.png'
import { AssistantMessage } from './components/AssistantMessage'
import { BrowserPanel } from './components/BrowserPanel'
import { CommandPalette, type PaletteEntry } from './components/CommandPalette'
import { ComposerAutocomplete } from './components/ComposerAutocomplete'
import { DiffPanel, WORKSPACE_TABS, type WorkspacePanelTab } from './components/DiffPanel'
import { ExtensionUiCard } from './components/ExtensionUiCard'
import { ForkTreeModal } from './components/ForkTreeModal'
import { ProjectTrustModal } from './components/ProjectTrustModal'
import { SettingsPage, SETTINGS_LINKS, settingsSectionLabel, type SettingsDestination } from './components/SettingsPage'
import { ShortcutsModal } from './components/ShortcutsModal'
import { Sidebar } from './components/Sidebar'
import { TerminalPanel } from './components/TerminalPanel'
import { WorkbenchHeader } from './components/WorkbenchHeader'

const MAX_IMAGES_PER_PROMPT = 4
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const PANEL_PREFS_KEY = 'agentui.workspace-panel'
const MIN_PANEL_WIDTH = 320
const DEFAULT_PANEL_WIDTH = 390
const EMPTY_TIMELINE: TimelineItem[] = []
const CONVERSATION_WIDTHS = { standard: '820px', wide: '1040px', full: 'none' } as const
const COMPACT_TRUST_LABELS: Record<TrustPreset, string> = {
  readonly: '只读', approval: '需审批', auto: '自动',
}

interface ComposerDraft {
  text: string
  images: ImageAttachment[]
}

const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: '', images: [] }

function panelWidthLimit(viewportWidth: number) {
  return Math.max(MIN_PANEL_WIDTH, Math.min(680, viewportWidth - 650))
}

function readPanelPreferences() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) ?? '{}')
    return {
      tab: WORKSPACE_TABS.find(([tab]) => tab === prefs.tab)?.[0] ?? 'changes',
      width: typeof prefs.width === 'number' && Number.isFinite(prefs.width)
        ? Math.max(MIN_PANEL_WIDTH, Math.min(680, prefs.width)) : DEFAULT_PANEL_WIDTH,
      open: prefs.open === true,
      terminalDocked: prefs.terminalDocked === true,
    } as const
  } catch {
    return { tab: 'changes', width: DEFAULT_PANEL_WIDTH, open: false, terminalDocked: false } as const
  }
}

function AttachmentPreview({ image, onOpen }: { image: ImageAttachment; onOpen: () => void }) {
  const src = `data:${image.mimeType};base64,${image.data}`
  return (
    <button type="button" className="attachment-preview" title="打开图片预览" onClick={onOpen}>
      <img src={src} alt={image.name ?? '附加图片'} />
      <img src={src} alt="" aria-hidden="true" className="attachment-hover" />
    </button>
  )
}

function readImageAsAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolveFile, rejectFile) => {
    const reader = new FileReader()
    reader.onerror = () => rejectFile(new Error(`读取图片失败: ${file.name || '剪贴板图片'}`))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const commaIdx = dataUrl.indexOf(',')
      if (commaIdx === -1) {
        rejectFile(new Error('无法解析图片 Base64 数据'))
        return
      }
      const data = dataUrl.slice(commaIdx + 1)
      resolveFile({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'image',
        data,
        mimeType: file.type || 'image/png',
        name: file.name || 'clipboard-image.png',
        sizeBytes: file.size,
      })
    }
    reader.readAsDataURL(file)
  })
}

export function App() {
  const [harnesses, setHarnesses] = useState<Record<HarnessId, HarnessStatus>>(
    () =>
      Object.fromEntries(
        HARNESS_IDS.map((id) => [
          id,
          { id, name: HARNESS_LABELS[id], path: null, version: null, ready: false, agentDir: '', sessionRoot: '' },
        ]),
      ) as Record<HarnessId, HarnessStatus>,
  )
  const [customPaths, setCustomPaths] = useState<Partial<Record<HarnessId, string>>>({})
  const [activeHarness, setActiveHarness] = useState<HarnessId>('pi')
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [threads, setThreads] = useState<ThreadEntry[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [timelines, setTimelines] = useState<Record<string, TimelineItem[]>>({})
  const [contextUsages, setContextUsages] = useState<Record<string, ContextUsageInfo>>({})
  const [catalogs, setCatalogs] = useState<Partial<Record<HarnessId, ModelCatalogResult>>>({})
  const [catalogLoading, setCatalogLoading] = useState<Partial<Record<HarnessId, boolean>>>({})
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE)
  const [conversation, setConversation] = useState(DEFAULT_CONVERSATION)
  const [defaultProjectTrust, setDefaultProjectTrust] = useState<TrustPreset>('approval')
  const [harnessDefaults, setHarnessDefaults] = useState<Partial<Record<HarnessId, HarnessDefaults>>>({})
  const [cliSessions, setCliSessions] = useState<CliSessionSummary[]>([])
  const [gitSnapshot, setGitSnapshot] = useState<{ cwd: string; status: GitStatusSummary | null } | null>(null)
  const [selectedTurn, setSelectedTurn] = useState<{ threadId: string; summaryId: string } | null>(null)
  const [initialPanel] = useState(readPanelPreferences)
  const [showDiffPanel, setShowDiffPanel] = useState(initialPanel.open)
  const [diffPanelTab, setDiffPanelTab] = useState<WorkspacePanelTab>(initialPanel.tab)
  const [panelWidth, setPanelWidth] = useState(initialPanel.width)
  const [panelWidthLimitPx, setPanelWidthLimitPx] = useState(() => panelWidthLimit(window.innerWidth))
  const [panelResizing, setPanelResizing] = useState(false)
  const [terminalDocked, setTerminalDocked] = useState(initialPanel.terminalDocked)
  const [browserVisited, setBrowserVisited] = useState(initialPanel.open && initialPanel.tab === 'browser')
  const [showPalette, setShowPalette] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsDestination, setSettingsDestination] = useState<SettingsDestination>({ section: 'engines' })
  const [trustProjectId, setTrustProjectId] = useState<string | null>(null)
  const [browserShotBusy, setBrowserShotBusy] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showForkModal, setShowForkModal] = useState(false)
  const [forkModalTab, setForkModalTab] = useState<'tree' | 'compare'>('tree')
  const [forkHighlightText, setForkHighlightText] = useState<string | null>(null)
  const [forkTree, setForkTree] = useState<SessionTreeSnapshot | null>(null)
  const [forkTreeLoading, setForkTreeLoading] = useState(false)
  const [pendingUiQueue, setPendingUiQueue] = useState<ExtensionUiRequest[]>([])
  const [statusTexts, setStatusTexts] = useState<Record<string, string | null>>({})
  const [disconnectInfos, setDisconnectInfos] = useState<Record<string, RuntimeDisconnectInfo | null>>({})
  const [dismissedDisconnectAt, setDismissedDisconnectAt] = useState<Record<string, number>>({})
  const [showDisconnectDetails, setShowDisconnectDetails] = useState(false)
  const [reconnectingThreadId, setReconnectingThreadId] = useState<string | null>(null)
  const [composerDrafts, setComposerDrafts] = useState(() => new Map<string | null, ComposerDraft>())
  const { text: promptText, images: attachedImages } = composerDrafts.get(activeThreadId) ?? EMPTY_COMPOSER_DRAFT
  const [composerCursor, setComposerCursor] = useState(0)
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null)
  const [dragOverComposer, setDragOverComposer] = useState(false)
  const [fileSuggestions, setFileSuggestions] = useState<WorkspaceFileEntry[]>([])
  const [fileSuggestionsLoading, setFileSuggestionsLoading] = useState(false)
  const [slashCommands, setSlashCommands] = useState<SlashCommandDescriptor[]>([...BUILTIN_SLASH_COMMANDS])
  const [acSelectedIndex, setAcSelectedIndex] = useState(0)
  const [acDismissedKey, setAcDismissedKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [draftModel, setDraftModel] = useState<{ harness: HarnessId; value: string } | null>(null)
  const [draftThinking, setDraftThinking] = useState<{ harness: HarnessId; value: ThinkingLevel } | null>(null)

  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const fileReqIdRef = useRef(0)
  const gitReqIdRef = useRef(0)
  const catalogRequests = useRef<Partial<Record<HarnessId, number>>>({})
  const settingsReturnFocus = useRef<HTMLElement | null>(null)
  const sendMenuRef = useRef<HTMLDetailsElement>(null)
  const creatingDraftThreadRef = useRef(false)
  const panelDragRef = useRef<{ x: number; width: number } | null>(null)

  const updateComposerDraft = useCallback((threadId: string | null, update: (draft: ComposerDraft) => ComposerDraft) => {
    setComposerDrafts((drafts) => {
      const next = new Map(drafts)
      const draft = update(drafts.get(threadId) ?? EMPTY_COMPOSER_DRAFT)
      if (draft.text || draft.images.length) next.set(threadId, draft)
      else next.delete(threadId)
      return next
    })
  }, [])

  function setPromptText(text: string | ((previous: string) => string)) {
    updateComposerDraft(activeThreadId, (draft) => ({ ...draft, text: typeof text === 'string' ? text : text(draft.text) }))
  }

  function setAttachedImages(update: (images: ImageAttachment[]) => ImageAttachment[]) {
    updateComposerDraft(activeThreadId, (draft) => ({ ...draft, images: update(draft.images) }))
  }

  const reportError = useCallback((error: unknown) => {
    setActionError(error instanceof Error ? error.message : String(error))
  }, [])

  const selectThread = useCallback((threadId: string) => {
    setActionError(null)
    setActiveThreadId(threadId)
    void window.agentui.setActiveThread(threadId).catch(reportError)
  }, [reportError])

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  )

  const activeProject = useMemo(
    () => projects.find((p) => p.id === (activeThread?.projectId ?? activeProjectId)) ?? null,
    [projects, activeThread, activeProjectId],
  )
  const recentProjects = useMemo(() => {
    const activity = new Map(projects.map((project) => [project.id, project.addedAt]))
    for (const thread of threads) {
      const last = activity.get(thread.projectId)
      if (last !== undefined && thread.updatedAt > last) activity.set(thread.projectId, thread.updatedAt)
    }
    return [...projects].sort((a, b) => activity.get(b.id)! - activity.get(a.id)!).slice(0, 4)
  }, [projects, threads])

  const effectiveHarness: HarnessId = activeThread?.harness ?? activeHarness
  const effectiveCwd = activeThread?.cwd ?? activeProject?.path ?? null
  const activeCatalog = catalogs[effectiveHarness]
  const newSessionDefaults = harnessDefaults[effectiveHarness]
  const selectedDraftModel = draftModel?.harness === effectiveHarness ? draftModel.value : undefined
  const selectedDraftThinking = draftThinking?.harness === effectiveHarness ? draftThinking.value : undefined
  const activeTimeline = (activeThread && timelines[activeThread.id]) || EMPTY_TIMELINE
  const gitStatus = gitSnapshot?.cwd === effectiveCwd ? gitSnapshot.status : null
  const pendingForThread = pendingUiQueue.filter((request) => request.threadId === activeThreadId)
  const activePendingUi = pendingForThread[0]

  // Virtualized timeline: only visible items are mounted; heights are measured
  // dynamically so streaming growth and long tool outputs stay smooth.
  const timelineVirtualizer = useVirtualizer({
    count: activeTimeline.length,
    getScrollElement: () => timelineScrollRef.current,
    estimateSize: () => 140,
    overscan: 6,
    getItemKey: (index) => activeTimeline[index]?.id ?? index,
  })
  const isStreaming =
    activeThread?.status === 'streaming' ||
    activeThread?.status === 'starting' ||
    activeThread?.status === 'compacting' ||
    activeThread?.status === 'waiting_ui' || Boolean(activePendingUi)

  const activeTrigger = useMemo(
    () => detectComposerTrigger(promptText, composerCursor),
    [promptText, composerCursor],
  )
  const triggerKey = activeTrigger ? `${activeTrigger.kind}:${activeTrigger.start}:${activeTrigger.query}` : null
  const showAutocomplete = Boolean(activeTrigger && triggerKey !== acDismissedKey)
  const filteredSlashCommands = useMemo(
    () => (activeTrigger?.kind === 'slash' ? filterSlashCommands(slashCommands, activeTrigger.query) : []),
    [slashCommands, activeTrigger],
  )
  const activeAcCount = activeTrigger?.kind === 'file' ? fileSuggestions.length : filteredSlashCommands.length

  const refreshGit = useCallback(async (cwd?: string) => {
    const requestId = ++gitReqIdRef.current
    if (!cwd) {
      setGitSnapshot(null)
      return
    }
    const status = await window.agentui.gitGetStatus(cwd).catch(() => null)
    if (requestId === gitReqIdRef.current) setGitSnapshot({ cwd, status })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify({ tab: diffPanelTab, width: panelWidth, open: showDiffPanel, terminalDocked }))
    } catch { /* Window preferences are optional. */ }
  }, [diffPanelTab, panelWidth, showDiffPanel, terminalDocked])

  useEffect(() => {
    function resize() { setPanelWidthLimitPx(panelWidthLimit(window.innerWidth)) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    if (showDiffPanel && diffPanelTab === 'browser') setBrowserVisited(true)
  }, [showDiffPanel, diffPanelTab])

  useEffect(() => {
    function closeSendMenu(event: PointerEvent) {
      const menu = sendMenuRef.current
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false
    }
    document.addEventListener('pointerdown', closeSendMenu)
    return () => document.removeEventListener('pointerdown', closeSendMenu)
  }, [])

  const loadModelCatalog = useCallback(async (harness: HarnessId, refresh = false) => {
    const request = (catalogRequests.current[harness] ?? 0) + 1
    catalogRequests.current[harness] = request
    setCatalogLoading((prev) => ({ ...prev, [harness]: true }))
    const res = await window.agentui.getModelCatalog(harness, refresh).catch((err: unknown): ModelCatalogResult => ({
      harness, models: [], warning: String(err), fetchedAt: Date.now(),
    }))
    if (catalogRequests.current[harness] === request) {
      setCatalogs((prev) => ({ ...prev, [harness]: res }))
      setCatalogLoading((prev) => ({ ...prev, [harness]: false }))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const [state, hStatuses] = await Promise.all([
        window.agentui.getState(),
        window.agentui.discoverHarnesses(false),
      ])
      setProjects(state.projects)
      setThreads(state.threads)
      setCustomPaths(state.customBinaryPaths)
      setAppearance(state.appearance)
      setConversation(state.conversation)
      setDefaultProjectTrust(state.defaultProjectTrust)
      setHarnessDefaults(state.harnessDefaults)
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
    if (activeThread && !timelines[activeThread.id]) {
      const targetId = activeThread.id
      void window.agentui.getThreadTimeline(targetId).then((items) => {
        setTimelines((prev) => ((prev[targetId]?.length ?? 0) > 0 ? prev : { ...prev, [targetId]: items }))
      })
    }
  }, [activeThread?.id])

  useEffect(() => {
    void refreshGit(effectiveCwd ?? undefined)
  }, [effectiveCwd, refreshGit])

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
                updatedAt: update.updatedAt ?? t.updatedAt,
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
      setPendingUiQueue((prev) => (req.dismissed ? dequeueUiRequest(prev, req.id) : enqueueUiRequest(prev, req)))
    })

    return () => {
      unsubEvent()
      unsubStatus()
      unsubUi()
    }
  }, [activeThreadId, activeThread?.cwd, refreshGit])

  useEffect(() => {
    setShowDisconnectDetails(false)
  }, [activeThreadId])

  // 独立浏览器「分享到会话」：内容填入目标会话的输入框，由用户确认后发送
  useEffect(() => {
    return window.agentui.onShareToComposer((event: ShareToComposerEvent) => {
      selectThread(event.threadId)
      if (event.kind === 'image') {
        if (!event.imageData || !event.mimeType) return
        if ((composerDrafts.get(event.threadId)?.images.length ?? 0) >= MAX_IMAGES_PER_PROMPT) {
          setActionError(`分享失败：单条消息最多附加 ${MAX_IMAGES_PER_PROMPT} 张图片`)
          return
        }
        const sizeBytes = Math.floor(event.imageData.length * 0.75) - (event.imageData.match(/=+$/)?.[0].length ?? 0)
        if (sizeBytes > MAX_IMAGE_BYTES) {
          setActionError('分享失败：截图超过 10MB 限制')
          return
        }
        const stamp = new Date().toLocaleTimeString().replace(/:/g, '')
        const shared: ImageAttachment = {
          id: `share-${crypto.randomUUID()}`,
          type: 'image' as const,
          data: event.imageData,
          mimeType: event.mimeType,
          name: `shared-${stamp}.png`,
          sizeBytes,
        }
        updateComposerDraft(event.threadId, (draft) => ({
          ...draft,
          images: [...draft.images, shared].slice(0, MAX_IMAGES_PER_PROMPT),
        }))
      } else {
        const text = event.kind === 'link'
          ? `[${event.title || event.url}](${event.url})`
          : `${event.text ?? ''}\n\n（来自网页：${event.fromUrl ?? ''}）`
        updateComposerDraft(event.threadId, (draft) => ({ ...draft, text: draft.text ? `${draft.text}\n\n${text}` : text }))
        requestAnimationFrame(() => {
          const end = composerRef.current?.value.length ?? 0
          setComposerCursor(end)
          composerRef.current?.setSelectionRange(end, end)
          composerRef.current?.focus()
        })
      }
    })
  }, [composerDrafts, selectThread, updateComposerDraft])

  useEffect(() => {
    if (!activeThread) {
      setSlashCommands([...BUILTIN_SLASH_COMMANDS])
      return
    }
    let cancelled = false
    void window.agentui
      .getThreadCommands(activeThread.id)
      .then((cmds) => {
        if (!cancelled && cmds.length > 0) setSlashCommands(cmds)
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([...BUILTIN_SLASH_COMMANDS])
      })
    return () => {
      cancelled = true
    }
  }, [activeThread?.id, activeThread?.status])

  useEffect(() => {
    setAcSelectedIndex(0)
  }, [triggerKey])

  useEffect(() => {
    if (!showAutocomplete || activeTrigger?.kind !== 'file' || !effectiveCwd) {
      if (activeTrigger?.kind !== 'file') setFileSuggestions([])
      setFileSuggestionsLoading(false)
      return
    }
    const reqId = (fileReqIdRef.current += 1)
    setFileSuggestionsLoading(true)
    const timer = setTimeout(() => {
      void window.agentui
        .listWorkspaceFiles(effectiveCwd, activeTrigger.query)
        .then((list) => {
          if (fileReqIdRef.current === reqId) {
            setFileSuggestions(list)
            setFileSuggestionsLoading(false)
          }
        })
        .catch(() => {
          if (fileReqIdRef.current === reqId) {
            setFileSuggestions([])
            setFileSuggestionsLoading(false)
          }
        })
    }, 60)
    return () => clearTimeout(timer)
  }, [showAutocomplete, activeTrigger?.kind, activeTrigger?.query, effectiveCwd])

  useEffect(() => {
    stickToBottomRef.current = true
  }, [activeThreadId])

  useEffect(() => {
    if (showSettings || !stickToBottomRef.current) return
    const el = timelineScrollRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [activeTimeline, activeThreadId, activePendingUi?.id, showSettings])

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
    if (nextHarness === effectiveHarness) return
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

  function openSettings(destination?: SettingsDestination) {
    if (!showSettings) settingsReturnFocus.current = document.activeElement as HTMLElement | null
    if (destination) setSettingsDestination(destination)
    setShowShortcuts(false)
    setShowSettings(true)
  }

  async function openBrowserWindow() {
    try {
      await window.agentui.browserWindowShow()
    } catch (err) {
      reportError(err)
    }
  }

  /** 技能页「插入输入框」：写入 Composer 并回到工作台。 */
  function insertToComposer(text: string) {
    setPromptText((prev) => (prev ? `${prev}${text} ` : `${text} `))
    setShowSettings(false)
    requestAnimationFrame(() => {
      const end = composerRef.current?.value.length ?? 0
      setComposerCursor(end)
      composerRef.current?.setSelectionRange(end, end)
      composerRef.current?.focus()
    })
  }

  function closeSettings() {
    setShowSettings(false)
    requestAnimationFrame(() => {
      const previous = settingsReturnFocus.current
      if (previous?.isConnected && previous !== document.body) previous.focus()
      else composerRef.current?.focus()
    })
  }

  async function saveAppearance(patch: Partial<AppearanceSettings>) {
    setAppearance(await window.agentui.setAppearance(patch))
  }

  async function saveConversation(patch: Partial<ConversationSettings>) {
    setConversation(await window.agentui.setConversationSettings(patch))
  }

  async function saveDefaultProjectTrust(preset: TrustPreset) {
    setDefaultProjectTrust(await window.agentui.setDefaultProjectTrust(preset))
  }

  async function saveHarnessDefaults(harness: HarnessId, defaults: HarnessDefaults) {
    const saved = await window.agentui.setHarnessDefaults(harness, defaults)
    setHarnessDefaults((prev) => ({ ...prev, [harness]: saved }))
  }

  async function refreshHarnessSettings() {
    const next = await window.agentui.discoverHarnesses(true)
    setHarnesses(next)
    for (const harness of HARNESS_IDS) void loadModelCatalog(harness, true)
  }

  async function saveEnginePath(harness: HarnessId, path: string | null) {
    const next = await window.agentui.setCustomBinaryPath(harness, path)
    setHarnesses(next)
    setCustomPaths((prev) => {
      const copy = { ...prev }
      if (path) copy[harness] = path
      else delete copy[harness]
      return copy
    })
    setCatalogs((prev) => ({ ...prev, [harness]: undefined }))
    void loadModelCatalog(harness, true)
  }

  function startDraft(projectId = activeProject?.id ?? activeProjectId) {
    setActionError(null)
    setShowDisconnectDetails(false)
    setActiveThreadId(null)
    setActiveProjectId(projectId)
    if (activeThread && activeHarness !== effectiveHarness) {
      setActiveHarness(effectiveHarness)
      void window.agentui.setActiveHarness(effectiveHarness).catch(reportError)
    }
    updateComposerDraft(null, () => EMPTY_COMPOSER_DRAFT)
    setComposerCursor(0)
    setDraftModel(null)
    setDraftThinking(null)
    void window.agentui.setActiveThread(null).catch(reportError)
    void window.agentui.setActiveProject(projectId).catch(reportError)
    requestAnimationFrame(() => composerRef.current?.focus())
  }

  async function saveProjectTrust(projectId: string, preset: TrustPreset) {
    const updated = await window.agentui.setProjectTrust(projectId, preset)
    setProjects((prev) => prev.map((project) => project.id === updated.id ? updated : project))
  }

  function stopCurrentTurn() {
    if (!activeThread) return
    const threadId = activeThread.id
    void window.agentui.abortThread(threadId)
      .then(() => setPendingUiQueue((prev) => pruneUiRequestsForThread(prev, threadId)))
      .catch(reportError)
  }

  function openWorkspaceTab(tab: WorkspacePanelTab, terminalPlacement = appearance.terminalPlacement) {
    setSelectedTurn(null)
    if (tab === 'terminal') {
      if (terminalPlacement === 'bottom') {
        dockTerminal()
        return
      }
      setTerminalDocked(false)
    }
    setDiffPanelTab(tab)
    setShowDiffPanel(true)
  }

  function dockTerminal() {
    setTerminalDocked(true)
    if (diffPanelTab === 'terminal') setDiffPanelTab('changes')
  }

  function toggleWorkspaceTool(tab: WorkspacePanelTab) {
    if (tab === 'terminal' && terminalDocked) {
      setTerminalDocked(false)
      return
    }
    if (showDiffPanel && (tab === diffPanelTab || (tab === 'changes' && diffPanelTab === 'worktrees'))) {
      setShowDiffPanel(false)
    } else openWorkspaceTab(tab)
  }

  function adjustPanelWidth(width: number) {
    setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(panelWidthLimitPx, Math.round(width))))
  }

  function attachBrowserScreenshot() {
    if (browserShotBusy) return
    if (attachedImages.length >= MAX_IMAGES_PER_PROMPT) {
      setActionError(`单条消息最多附加 ${MAX_IMAGES_PER_PROMPT} 张图片`)
      return
    }
    setBrowserShotBusy(true)
    void window.agentui.browserScreenshot().then((shot) => {
      const sizeBytes = Math.floor(shot.data.length * 0.75)
      if (sizeBytes > MAX_IMAGE_BYTES) {
        setActionError('截图超过 10MB 限制，无法附加')
        return
      }
      setAttachedImages((prev) => [...prev, {
        id: `browser-shot-${Date.now()}`,
        type: 'image' as const,
        data: shot.data,
        mimeType: shot.mimeType,
        name: `browser-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`,
        sizeBytes,
      }].slice(0, MAX_IMAGES_PER_PROMPT))
      composerRef.current?.focus()
    }).catch(reportError).finally(() => setBrowserShotBusy(false))
  }

  async function addImageFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList).filter((f) => f.type.startsWith('image/'))
    if (incoming.length === 0) return
    setActionError(null)

    const remaining = MAX_IMAGES_PER_PROMPT - attachedImages.length
    if (remaining <= 0) {
      setActionError(`单条消息最多附加 ${MAX_IMAGES_PER_PROMPT} 张图片`)
      return
    }

    const accepted: ImageAttachment[] = []
    for (const file of incoming.slice(0, remaining)) {
      if (file.size > MAX_IMAGE_BYTES) {
        setActionError(`图片 ${file.name || ''} 超过 10MB 上限，已跳过`)
        continue
      }
      try {
        accepted.push(await readImageAsAttachment(file))
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
    if (accepted.length > 0) {
      setAttachedImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES_PER_PROMPT))
    }
  }

  function applyComposerAutocomplete(replacement: string) {
    if (!activeTrigger) return
    const { nextText, nextCursor } = applyTriggerInsertion(promptText, activeTrigger, replacement)
    setPromptText(nextText)
    setComposerCursor(nextCursor)
    setAcDismissedKey(null)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  async function refreshForkTreeFor(threadId: string) {
    setForkTreeLoading(true)
    try {
      const snap = await window.agentui.getThreadForkTree(threadId)
      setForkTree(snap)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setForkTreeLoading(false)
    }
  }

  async function openForkModal(tab: 'tree' | 'compare' = 'tree', highlightText?: string | null) {
    if (!activeThread) {
      setActionError('请先选择一个会话后再查看分叉树')
      return
    }
    setForkModalTab(tab)
    setForkHighlightText(highlightText ?? null)
    setShowForkModal(true)
    await refreshForkTreeFor(activeThread.id)
  }

  async function handleForkThread(input: { entryId?: string | null; mode: 'new-thread' | 'in-place'; harness?: HarnessId }) {
    if (!activeThread) return
    setActionError(null)
    const result = await window.agentui.forkThread({
      threadId: activeThread.id,
      entryId: input.entryId ?? null,
      mode: input.mode,
      harness: input.harness,
    })
    if (result.cancelled) return

    if (input.mode === 'new-thread') {
      setThreads((prev) => [result.thread, ...prev])
      setActiveThreadId(result.thread.id)
      setActiveHarness(result.thread.harness)
    } else {
      setThreads((prev) => prev.map((t) => (t.id === result.thread.id ? result.thread : t)))
    }
    const items = await window.agentui.getThreadTimeline(result.thread.id)
    setTimelines((prev) => ({ ...prev, [result.thread.id]: items }))
    setShowForkModal(false)
    const prefillText = result.prefillText
    if (prefillText) {
      updateComposerDraft(result.thread.id, (draft) => ({ ...draft, text: prefillText }))
      setComposerCursor(prefillText.length)
      requestAnimationFrame(() => {
        composerRef.current?.focus()
        composerRef.current?.setSelectionRange(prefillText.length, prefillText.length)
      })
    }
  }

  async function handleSend(behavior?: 'steer' | 'followUp') {
    const trimmed = promptText.trim()
    if (!trimmed && attachedImages.length === 0) return
    setActionError(null)

    // Execute built-in workbench slash commands directly before sending to CLI
    if (attachedImages.length === 0) {
      const builtin = parseBuiltinSlashCommand(trimmed)
      if (builtin) {
        setPromptText('')
        setComposerCursor(0)
        if (builtin.type === 'new') {
          if (activeProject) await handleNewThread(activeProject.id, effectiveHarness)
          else await handleAddProject()
        } else if (builtin.type === 'diff') {
          openWorkspaceTab('changes')
        } else if (builtin.type === 'worktree') {
          openWorkspaceTab('worktrees')
        } else if (builtin.type === 'shortcuts') {
          setShowShortcuts(true)
        } else if (builtin.type === 'settings') {
          openSettings()
        } else if (builtin.type === 'fork') {
          await openForkModal('tree')
        } else if (builtin.type === 'clone') {
          try {
            await handleForkThread({ entryId: null, mode: 'new-thread' })
          } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err))
          }
        } else if (builtin.type === 'compact') {
          if (!activeThread) setActionError('请先选择一个会话')
          else await window.agentui.compactThread(activeThread.id).catch((e) => setActionError(String(e)))
        } else if (builtin.type === 'reconnect') {
          if (!activeThread) setActionError('请先选择一个会话')
          else await handleReconnect(activeThread.id)
        } else if (builtin.type === 'retry') {
          if (!activeThread || !retryPromptCandidate) setActionError('当前会话没有可重试的上一条指令')
          else await handleRetryLastPrompt(activeThread.id, retryPromptCandidate)
        } else if (builtin.type === 'thinking') {
          if (!activeThread) {
            setActionError('请先选择一个会话')
          } else {
            await window.agentui
              .setThreadThinking(activeThread.id, builtin.level)
              .then(() => {
                setThreads((prev) =>
                  prev.map((t) => (t.id === activeThread.id ? { ...t, thinkingLevel: builtin.level } : t)),
                )
              })
              .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
          }
        }
        return
      }
    }

    let targetThread = activeThread
    if (!targetThread) {
      if (!activeProject) {
        setActionError('请先在左侧添加一个本地项目目录')
        return
      }
      if (creatingDraftThreadRef.current) return
      creatingDraftThreadRef.current = true
      try {
        const [modelProvider, modelId] = (selectedDraftModel ?? '').split('::')
        const created = await window.agentui.createThread({
          projectId: activeProject.id,
          harness: activeHarness,
          ...(selectedDraftModel !== undefined ? { modelProvider: modelId ? modelProvider : null, modelId: modelId || null } : {}),
          thinkingLevel: selectedDraftThinking,
        })
        targetThread = created
        setThreads((prev) => [created, ...prev])
        setActiveThreadId(created.id)
      } catch (error) {
        reportError(error)
        return
      } finally {
        creatingDraftThreadRef.current = false
      }
    }

    const msg = promptText
    const imagesToSend = attachedImages
    const displayText = msg.trim() || (imagesToSend.length > 0 ? '请查看附带的图片' : '')
    updateComposerDraft(activeThreadId, () => EMPTY_COMPOSER_DRAFT)
    setComposerCursor(0)
    setAcDismissedKey(null)

    if (!isStreaming) {
      setTimelines((prev) => ({
        ...prev,
        [targetThread!.id]: [
          ...(prev[targetThread!.id] ?? []),
          {
            id: `opt-${Date.now()}`,
            role: 'user',
            text: displayText,
            images: imagesToSend.length > 0 ? imagesToSend : undefined,
            timestamp: Date.now(),
          },
        ],
      }))
    }

    try {
      await window.agentui.sendPrompt({
        threadId: targetThread.id,
        message: displayText,
        images: imagesToSend.length > 0 ? imagesToSend : undefined,
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
      : !activeThread ? selectedDraftModel ?? (newSessionDefaults?.model
        ? `${newSessionDefaults.model.provider}::${newSessionDefaults.model.id}` : '') : ''

  const currentCtxUsage = activeThread ? contextUsages[activeThread.id] : undefined
  const currentStatusText = activeThread ? statusTexts[activeThread.id] : null
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
  const showStartup = !activeTimeline.length && !activePendingUi && !isStreaming && !showDisconnectBanner
  const currentPanelWidth = Math.min(panelWidth, panelWidthLimitPx)
  const showTerminalAtRight = showDiffPanel && diffPanelTab === 'terminal' && !terminalDocked
  const hasDraft = Boolean(promptText.trim() || attachedImages.length)
  const trustPreset = activeProject?.trustPreset ?? 'approval'

  const settingsEntries: PaletteEntry[] = showPalette ? SETTINGS_LINKS.map((entry) => ({
    id: `setting-${entry.label}`, label: entry.label, detail: settingsSectionLabel(entry.section),
    keywords: entry.keywords, group: '设置', run: () => openSettings(entry),
  })) : []
  const paletteEntries: PaletteEntry[] = showPalette && !showSettings ? [
    ...[...threads].sort((a, b) => b.updatedAt - a.updatedAt).map((thread): PaletteEntry => ({
      id: thread.id, label: thread.title, detail: `${projects.find((p) => p.id === thread.projectId)?.name ?? ''} · ${HARNESS_LABELS[thread.harness]}`,
      keywords: `${thread.cwd} ${thread.worktreeBranch ?? ''}`, group: '会话', run: () => selectThread(thread.id),
    })),
    ...HARNESS_IDS.map((harness): PaletteEntry => ({
      id: `engine-${harness}`, label: `切换到 ${HARNESS_LABELS[harness]}`, group: '引擎',
      detail: harnesses[harness]?.ready ? '就绪' : '未就绪', run: () => void handleSwitchComposerHarness(harness),
    })),
    ...WORKSPACE_TABS.map(([tab, label]): PaletteEntry => ({
      id: tab, label: `打开${label}面板`, keywords: tab, group: '工作区', run: () => openWorkspaceTab(tab),
    })),
    { id: 'terminal-dock', label: '打开底部终端', keywords: 'terminal dock', group: '工作区', run: dockTerminal },
    { id: 'browser-window', label: '打开独立浏览器', keywords: 'browser web 浏览器 网页', group: '工作区', run: () => void openBrowserWindow() },
    { id: 'new-draft', label: '新建会话', group: '会话', run: () => startDraft() },
    { id: 'add-project', label: '添加项目', group: '工作区', run: () => void handleAddProject() },
    ...settingsEntries,
  ] : settingsEntries

  const shortcutCtxRef = useRef<{
    onShortcut: (action: ReturnType<typeof matchGlobalShortcut>, e: KeyboardEvent) => void
  }>({ onShortcut: () => undefined })

  shortcutCtxRef.current.onShortcut = (action, e) => {
    if (!action) return
    const targetEl = e.target as HTMLElement | null

    if (action === 'escape') {
      if (targetEl?.classList?.contains('inline-rename-input')) return
      if (showPalette) return
      if (previewImage) {
        e.preventDefault()
        setPreviewImage(null)
        return
      }
      if (showForkModal) {
        e.preventDefault()
        setShowForkModal(false)
        return
      }
      if (showShortcuts) {
        e.preventDefault()
        setShowShortcuts(false)
        return
      }
      if (showSettings) {
        e.preventDefault()
        closeSettings()
        return
      }
      if (trustProjectId) {
        e.preventDefault()
        setTrustProjectId(null)
        return
      }
      if (sendMenuRef.current?.open) {
        e.preventDefault()
        sendMenuRef.current.open = false
        sendMenuRef.current.querySelector('summary')?.focus()
        return
      }
      if (showAutocomplete) return
      if (activePendingUi) return
      if (isStreaming && activeThread) {
        e.preventDefault()
        stopCurrentTurn()
      }
      return
    }

    if (showPalette && action !== 'open-palette') return
    if (showSettings && action !== 'open-palette' && action !== 'toggle-settings') return

    e.preventDefault()
    if (action === 'new-thread') {
      startDraft()
    } else if (action === 'open-palette') {
      setShowPalette((open) => !open)
    } else if (action === 'focus-composer') {
      composerRef.current?.focus()
    } else if (action === 'toggle-diff') {
      toggleWorkspaceTool('changes')
    } else if (action === 'open-worktrees') {
      openWorkspaceTab('worktrees')
    } else if (action === 'open-files') {
      openWorkspaceTab('files')
    } else if (action === 'open-terminal') {
      if (!terminalDocked) openWorkspaceTab('terminal')
    } else if (action === 'switch-pi') {
      void handleSwitchComposerHarness('pi')
    } else if (action === 'switch-omp') {
      void handleSwitchComposerHarness('omp')
    } else if (action === 'switch-prime') {
      void handleSwitchComposerHarness('prime')
    } else if (action === 'toggle-settings') {
      if (showSettings) closeSettings()
      else openSettings()
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

  function renderTimelineItem(item: TimelineItem) {
    if (item.role === 'user') {
      return (
        <div className="msg-user-wrap">
          <div className="msg-user">
            {item.images && item.images.length > 0 && (
              <div className="msg-user-images">
                {item.images.map((img) => (
                  <AttachmentPreview key={img.id} image={img} onOpen={() => setPreviewImage(img)} />
                ))}
              </div>
            )}
            {item.text}
          </div>
          <div className="msg-user-actions">
            <button
              type="button"
              className="btn-small"
              style={{ padding: '2px 7px', fontSize: 12.5 }}
              title="从此条提问分叉出新分支进行多方案对比"
              onClick={() => void openForkModal('tree', item.text)}
            >
              <GitFork size={10} />
              从此处分叉
            </button>
          </div>
        </div>
      )
    }
    if (item.role === 'notice') {
      if (item.details) return (
        <details className={`msg-notice notice-details ${item.kind}`}>
          <summary>{item.text}</summary>
          <p>{item.details}</p>
        </details>
      )
      return <div className={`msg-notice ${item.kind}`}>{item.text}</div>
    }
    if (item.role === 'change-summary') {
      return (
        <button type="button" className="turn-changes" title="查看本回合的文件差异"
          onClick={() => {
            if (!activeThreadId) return
            openWorkspaceTab('changes')
            setSelectedTurn({ threadId: activeThreadId, summaryId: item.id })
          }}>
          <GitCompareArrows size={15} /><span>变更了 {item.changes.files} 个文件</span>
          <span className="turn-changes-added">+{item.changes.added}</span>
          <span className="turn-changes-removed">−{item.changes.removed}</span>
          <ChevronRight size={13} />
        </button>
      )
    }
    return <AssistantMessage item={item} codeFontSize={appearance.codeFontSize} collapseToolGroups={conversation.collapseToolGroups} />
  }

  return (
    <div className="app-shell" data-reduce-motion={appearance.reduceMotion || undefined}
      style={{ '--conversation-width': CONVERSATION_WIDTHS[appearance.conversationWidth], '--code-font-size': `${appearance.codeFontSize}px` } as CSSProperties}>
      <WorkbenchHeader
        thread={activeThread} harness={effectiveHarness} ready={harnesses[effectiveHarness]?.ready ?? false}
        cwd={effectiveCwd} context={currentCtxUsage} statusText={currentStatusText}
        activeTool={showDiffPanel ? diffPanelTab : null} terminalDocked={terminalDocked}
        onToggleTool={toggleWorkspaceTool} onOpenPalette={() => setShowPalette(true)}
        onOpenBrowserWindow={() => void openBrowserWindow()}
        onCloseSettings={showSettings ? closeSettings : undefined}
        onFork={() => void openForkModal('tree')}
        onCompact={() => {
          if (activeThread) void window.agentui.compactThread(activeThread.id).catch(reportError)
        }}
      />
      <div className="workspace-body" hidden={showSettings}>
        <Sidebar
          harnesses={harnesses}
          activeHarness={effectiveHarness}
          projects={projects}
          threads={threads}
          activeProjectId={activeProject?.id ?? null}
          activeThreadId={activeThreadId}
          cliSessions={cliSessions}
          onSelectHarness={(id) => void handleSwitchComposerHarness(id)}
          onRefreshHarnesses={() => void refreshHarnessSettings().catch(reportError)}
          onOpenShortcuts={() => setShowShortcuts(true)}
          onOpenSettings={() => openSettings()}
          onOpenPalette={() => setShowPalette(true)}
          onStartDraft={() => startDraft()}
          onAddProject={() => void handleAddProject()}
          onRemoveProject={(id) => {
            const removedIds = new Set(threads.filter((t) => t.projectId === id).map((t) => t.id))
            void window.agentui
              .removeProject(id)
              .then(() => {
                setProjects((prev) => prev.filter((p) => p.id !== id))
                setThreads((prev) => prev.filter((t) => t.projectId !== id))
                setComposerDrafts((drafts) => new Map([...drafts].filter(([threadId]) => threadId === null || !removedIds.has(threadId))))
                setPendingUiQueue((prev) => prev.filter((item) => !removedIds.has(item.threadId)))
                if (activeThreadId && removedIds.has(activeThreadId)) setActiveThreadId(null)
                if (activeProjectId === id) setActiveProjectId(projects.find((project) => project.id !== id)?.id ?? null)
              })
              .catch((e) => setActionError(e instanceof Error ? e.message : String(e)))
          }}
          onNewThread={(pid, harness) => void handleNewThread(pid, harness)}
          onOpenTrust={(pid) => setTrustProjectId(pid)}
          onSelectThread={selectThread}
          onDeleteThread={(tid) =>
            void window.agentui
              .deleteThread(tid)
              .then(() => {
                setThreads((prev) => prev.filter((t) => t.id !== tid))
                updateComposerDraft(tid, () => EMPTY_COMPOSER_DRAFT)
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

        <div
          className={`work-area${showDiffPanel ? ' panel-open' : ''}${terminalDocked ? ' has-terminal-dock' : ''}${panelResizing ? ' is-resizing' : ''}`}
          style={{ '--panel-width': `${currentPanelWidth}px` } as CSSProperties}
        >
          <main className="main-pane">
            {showDisconnectBanner && activeThread && disconnectReason && (
              <section className={`disconnect-banner${activeThread.status === 'error' ? ' is-error' : ''}`} aria-label="连接状态">
                <div className="disconnect-banner-top">
                  <button type="button" className="disconnect-banner-info" aria-expanded={showDisconnectDetails}
                    onClick={() => setShowDisconnectDetails(!showDisconnectDetails)}>
                    {activeThread.status === 'error' ? <AlertTriangle size={14} /> : <WifiOff size={14} />}
                    <span>{activeThread.status === 'error' ? '连接失败' : '连接已断开'}</span>
                    <ChevronRight size={13} className={showDisconnectDetails ? 'project-chevron expanded' : 'project-chevron'} />
                  </button>
                  <div className="disconnect-actions">
                    <button type="button" className="btn-small" disabled={reconnectingThreadId === activeThread.id}
                      onClick={() => void handleReconnect(activeThread.id)}>
                      <RefreshCw size={12} className={reconnectingThreadId === activeThread.id ? 'spin' : undefined} />
                      {reconnectingThreadId === activeThread.id ? '重连中…' : '重新连接'}
                    </button>
                    {retryPromptCandidate && <button type="button" className="btn-small"
                      disabled={reconnectingThreadId === activeThread.id}
                      onClick={() => void handleRetryLastPrompt(activeThread.id, retryPromptCandidate)}>
                      <RotateCcw size={12} /> 重试上一条
                    </button>}
                    <button type="button" className="icon-btn" title="隐藏连接提示" aria-label="隐藏连接提示"
                      onClick={() => setDismissedDisconnectAt((prev) => ({ ...prev, [activeThread.id]: disconnectMarker }))}>
                      <X size={13} />
                    </button>
                  </div>
                </div>
                {showDisconnectDetails && <div className="disconnect-details">
                  <p>{disconnectReason}</p>
                  {activeDisconnectInfo?.stderrTail && <pre className="disconnect-stderr">{activeDisconnectInfo.stderrTail}</pre>}
                </div>}
              </section>
            )}
            <div className={`conversation-body${showStartup ? ' startup-view' : ''}`}>
              {actionError && <div className="action-error msg-notice error" role="alert">{actionError}</div>}
              {showStartup && <div className="startup-heading">
                <img src={brandIcon} alt="" />
                <h1>今天要做些什么？</h1>
                {activeProject && <span className="startup-project"><FolderGit2 size={14} />{activeProject.name}</span>}
              </div>}
              {!showStartup && (
                <div className="timeline-scroll" ref={timelineScrollRef} onScroll={(event) => {
                  const el = event.currentTarget
                  stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                }}>
                  <div className="timeline-content">
                    <div style={{ height: timelineVirtualizer.getTotalSize(), position: 'relative' }}>
                      {timelineVirtualizer.getVirtualItems().map((virtualItem) => {
                        const item = activeTimeline[virtualItem.index]
                        if (!item) return null
                        return (
                          <div key={virtualItem.key} data-index={virtualItem.index} ref={timelineVirtualizer.measureElement}
                            className="timeline-row" style={{ transform: `translateY(${virtualItem.start}px)` }}>
                            {renderTimelineItem(item)}
                          </div>
                        )
                      })}
                    </div>
                    {activePendingUi && (
                      <ExtensionUiCard key={activePendingUi.id} request={activePendingUi}
                        queueLength={pendingForThread.length}
                        onRespond={async (response) => {
                          await window.agentui.respondExtensionUi(activePendingUi.threadId, response)
                          setPendingUiQueue((prev) => dequeueUiRequest(prev, activePendingUi.id))
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
              <div className="composer-wrap">
                <div className="trust-quick">
                  <label className="trust-switch">
                    <Shield size={13} /><span>权限 / 信任模式</span>
                    <select aria-label="权限 / 信任模式" value={activeProject ? trustPreset : ''} disabled={!activeProject}
                      title="工具权限在引擎发起审批时生效"
                      onChange={(event) => {
                        if (activeProject) void saveProjectTrust(activeProject.id, event.target.value as TrustPreset).catch(reportError)
                      }}>
                      {!activeProject && <option value="">请选择项目</option>}
                      {TRUST_PRESETS.map((preset) => <option key={preset} value={preset}>{TRUST_PRESET_LABELS[preset]}</option>)}
                    </select>
                  </label>
                </div>
                {showAutocomplete && activeTrigger && (
                  <ComposerAutocomplete
                    kind={activeTrigger.kind}
                    query={activeTrigger.query}
                    files={fileSuggestions}
                    commands={filteredSlashCommands}
                    selectedIndex={acSelectedIndex}
                    loading={fileSuggestionsLoading}
                    onHoverIndex={setAcSelectedIndex}
                    onSelectFile={(entry) => applyComposerAutocomplete(`@${entry.path}`)}
                    onSelectCommand={(cmd) => {
                      applyComposerAutocomplete(`/${cmd.name}`)
                    }}
                  />
                )}

                <div
                  className={`composer-box ${dragOverComposer ? 'drag-over' : ''}`}
                  onDragOver={(e) => {
                    if (Array.from(e.dataTransfer.types).includes('Files')) {
                      e.preventDefault()
                      setDragOverComposer(true)
                    }
                  }}
                  onDragLeave={() => setDragOverComposer(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOverComposer(false)
                    if (e.dataTransfer.files?.length) {
                      void addImageFiles(e.dataTransfer.files)
                    }
                  }}
                >
                  {attachedImages.length > 0 && (
                    <div className="composer-attachments">
                      {attachedImages.map((img) => (
                        <div key={img.id} className="attachment-chip">
                          <AttachmentPreview image={img} onOpen={() => setPreviewImage(img)} />
                          <div className="attachment-meta">
                            <span className="attachment-name" title={img.name}>
                              {img.name ?? '剪贴板图片'}
                            </span>
                            {img.sizeBytes !== undefined && (
                              <span className="attachment-size">{Math.max(1, Math.round(img.sizeBytes / 1024))} KB</span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="icon-btn"
                            style={{ width: 20, height: 20 }}
                            title="移除图片"
                            onClick={() => setAttachedImages((prev) => prev.filter((item) => item.id !== img.id))}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        void addImageFiles(e.target.files)
                        e.target.value = ''
                      }
                    }}
                  />

                  <textarea
                    ref={composerRef}
                    className="composer-textarea"
                    aria-label="指令输入框"
                    placeholder={activeProject ? '描述你想完成的任务…' : '选一个项目，开始编写指令…'}
                    value={promptText}
                    onChange={(e) => {
                      setPromptText(e.target.value)
                      setComposerCursor(e.target.selectionStart ?? e.target.value.length)
                      setAcDismissedKey(null)
                    }}
                    onClick={(e) => setComposerCursor(e.currentTarget.selectionStart ?? promptText.length)}
                    onKeyUp={(e) => setComposerCursor(e.currentTarget.selectionStart ?? promptText.length)}
                    onSelect={(e) => setComposerCursor(e.currentTarget.selectionStart ?? promptText.length)}
                    onPaste={(e) => {
                      const items = e.clipboardData?.items
                      if (!items) return
                      const imgFiles: File[] = []
                      for (const item of Array.from(items)) {
                        if (item.type.startsWith('image/')) {
                          const f = item.getAsFile()
                          if (f) imgFiles.push(f)
                        }
                      }
                      if (imgFiles.length > 0) {
                        if (!e.clipboardData.getData('text/plain')) {
                          e.preventDefault()
                        }
                        void addImageFiles(imgFiles)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return

                      if (showAutocomplete && activeTrigger) {
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          setAcDismissedKey(triggerKey)
                          return
                        }
                        if (e.key === 'ArrowDown' && activeAcCount > 0) {
                          e.preventDefault()
                          setAcSelectedIndex((i) => (i + 1) % activeAcCount)
                          return
                        }
                        if (e.key === 'ArrowUp' && activeAcCount > 0) {
                          e.preventDefault()
                          setAcSelectedIndex((i) => (i - 1 + activeAcCount) % activeAcCount)
                          return
                        }
                        if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) && activeAcCount > 0) {
                          const safeIdx = Math.min(acSelectedIndex, activeAcCount - 1)
                          if (activeTrigger.kind === 'file') {
                            e.preventDefault()
                            const entry = fileSuggestions[safeIdx]
                            if (entry) applyComposerAutocomplete(`@${entry.path}`)
                            return
                          }
                          const cmd = filteredSlashCommands[safeIdx]
                          const exactParameterlessEnter =
                            e.key === 'Enter' &&
                            cmd &&
                            !cmd.argsHint &&
                            cmd.name.toLowerCase() === activeTrigger.query.toLowerCase()
                          if (!exactParameterlessEnter) {
                            e.preventDefault()
                            if (cmd) applyComposerAutocomplete(`/${cmd.name}`)
                            return
                          }
                        }
                      }

                      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                        e.preventDefault()
                        const behavior = isStreaming ? runningMessageAction(conversation.enterWhileRunning, e.ctrlKey || e.metaKey) : undefined
                        void handleSend(behavior)
                        return
                      }
                      if (e.key === 'ArrowUp' && !promptText && lastUserPromptInTimeline) {
                        e.preventDefault()
                        setPromptText(lastUserPromptInTimeline)
                        setComposerCursor(lastUserPromptInTimeline.length)
                      }
                    }}
                  />

                  <div className="composer-toolbar">
                    <div className="composer-controls">
                      <button type="button" className="icon-btn composer-attach" title="添加图片 (Ctrl+V)" aria-label="添加图片"
                        onClick={() => imageInputRef.current?.click()}><ImagePlus size={16} /></button>
                      <select className="select-pill composer-model" aria-label="模型" title="切换模型" value={currentModelValue}
                        onChange={(event) => {
                          const value = event.target.value
                          if (!activeThread) {
                            setDraftModel({ harness: effectiveHarness, value })
                            return
                          }
                          if (!value) return
                          const [provider, modelId] = value.split('::')
                          void window.agentui.setThreadModel(activeThread.id, provider, modelId).then(() => {
                            setThreads((prev) => prev.map((thread) => thread.id === activeThread.id
                              ? { ...thread, modelProvider: provider, modelId } : thread))
                          }).catch(reportError)
                        }}>
                        <option value="" disabled={Boolean(activeThread && currentModelValue)}>默认模型</option>
                        {currentModelValue && !activeCatalog?.models.some((model) => `${model.provider}::${model.id}` === currentModelValue) && (
                          <option value={currentModelValue}>{currentModelValue.replace('::', '/')}</option>
                        )}
                        {(activeCatalog?.models ?? []).map((model) => (
                          <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>{model.id}</option>
                        ))}
                      </select>
                      <select className="select-pill composer-thinking" aria-label="Thinking" title="Thinking 推理强度"
                      value={activeThread?.thinkingLevel ?? selectedDraftThinking ?? newSessionDefaults?.thinkingLevel ?? 'medium'}
                        onChange={(event) => {
                          const level = event.target.value as ThinkingLevel
                          if (!activeThread) {
                          setDraftThinking({ harness: effectiveHarness, value: level })
                            return
                          }
                          void window.agentui.setThreadThinking(activeThread.id, level).then(() => {
                            setThreads((prev) => prev.map((thread) => thread.id === activeThread.id ? { ...thread, thinkingLevel: level } : thread))
                          }).catch(reportError)
                        }}>
                      {THINKING_LEVELS.map((level) => <option key={level} value={level}>Thinking · {THINKING_LABELS[level]}</option>)}
                      </select>
                      <button type="button" className="composer-trust" disabled={!activeProject} title="项目信任设置"
                      aria-label={activeProject ? `信任模式 ${TRUST_PRESET_LABELS[trustPreset]}` : '信任模式'}
                        onClick={() => { if (activeProject) setTrustProjectId(activeProject.id) }}>
                      <Shield size={12} />
                      <span className="composer-trust-full">{activeProject ? TRUST_PRESET_LABELS[trustPreset] : '信任模式'}</span>
                      {activeProject && <span className="composer-trust-compact" aria-hidden="true">{COMPACT_TRUST_LABELS[trustPreset]}</span>}
                      </button>
                      {activeProject && <button type="button" className="icon-btn composer-worktree"
                        title="工作树 (Ctrl+Shift+W)" aria-label="工作树" onClick={() => openWorkspaceTab('worktrees')}>
                        <GitBranch size={14} />
                      </button>}
                    </div>

                    <div className="send-controls">
                      {isStreaming && <details ref={sendMenuRef} className="send-menu">
                        <summary className="icon-btn" aria-label="运行中的发送方式" title="Steer / Follow-up"><ChevronDown size={14} /></summary>
                        <div className="floating-card send-options">
                          <button type="button" disabled={!hasDraft} onClick={() => {
                            if (sendMenuRef.current) sendMenuRef.current.open = false
                            void handleSend('steer')
                          }}><Zap size={14} /> 引导（Steer） <kbd>{conversation.enterWhileRunning === 'steer' ? 'Enter' : 'Ctrl Enter'}</kbd></button>
                          <button type="button" disabled={!hasDraft} onClick={() => {
                            if (sendMenuRef.current) sendMenuRef.current.open = false
                            void handleSend('followUp')
                          }}><ArrowUp size={14} /> 排队（Follow-up） <kbd>{conversation.enterWhileRunning === 'followUp' ? 'Enter' : 'Ctrl Enter'}</kbd></button>
                        </div>
                      </details>}
                      <button type="button" className="send-button" disabled={!isStreaming && !hasDraft}
                        aria-label={isStreaming ? '停止生成' : '发送'} title={isStreaming ? '停止生成' : '发送 (Enter)'}
                        onClick={() => isStreaming ? stopCurrentTurn() : void handleSend()}>
                        {isStreaming ? <Square size={13} fill="currentColor" /> : <ArrowUp size={20} strokeWidth={2.4} />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              {showStartup && <section className="recent-projects" aria-label="最近项目">
                <div className="recent-heading">
                  {recentProjects.length > 0 && <h2>最近项目</h2>}
                  {recentProjects.length === 0 && <button type="button" className="btn-small" onClick={() => void handleAddProject()}><FolderPlus size={14} /> 添加项目</button>}
                </div>
                {recentProjects.length > 0 && <div className="recent-project-list">
                  {recentProjects.map((project) => (
                    <button type="button" key={project.id} className="recent-project" title={project.path}
                      aria-pressed={activeProject?.id === project.id} onClick={() => startDraft(project.id)}>
                      <FolderGit2 size={15} /><span>{project.name}</span><ChevronRight size={13} />
                    </button>
                  ))}
                </div>}
              </section>}
            </div>
          </main>

          <div className="workspace-side" id="workspace-panel" inert={!showDiffPanel} aria-hidden={!showDiffPanel}>
            <DiffPanel
              cwd={effectiveCwd ?? ''}
              repoRoot={gitStatus?.repoRoot}
              status={gitStatus}
              activeTab={diffPanelTab}
              selectedTurn={selectedTurn?.threadId === activeThreadId ? selectedTurn : null}
              onShowWorkingDiff={() => setSelectedTurn(null)}
              terminalDocked={terminalDocked}
              browser={browserVisited ? <BrowserPanel screenshotBusy={browserShotBusy} onScreenshot={attachBrowserScreenshot} /> : null}
              onDockTerminal={dockTerminal}
              onTabChange={openWorkspaceTab}
              onRefresh={() => void refreshGit(effectiveCwd ?? undefined)}
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
                await refreshGit(effectiveCwd ?? undefined)
              }}
              onReferenceFile={(relPath) => {
                const next = `${promptText}${promptText && !promptText.endsWith(' ') ? ' ' : ''}@${relPath} `
                setPromptText(next)
                setComposerCursor(next.length)
                requestAnimationFrame(() => {
                  composerRef.current?.focus()
                  composerRef.current?.setSelectionRange(next.length, next.length)
                })
              }}
            />
          </div>
          {showDiffPanel && <div className="panel-resize" role="separator" aria-label="调整工作区面板宽度"
            aria-orientation="vertical" aria-controls="workspace-panel"
            aria-valuemin={MIN_PANEL_WIDTH} aria-valuemax={panelWidthLimitPx} aria-valuenow={currentPanelWidth} tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              panelDragRef.current = { x: event.clientX, width: currentPanelWidth }
              event.currentTarget.setPointerCapture(event.pointerId)
              setPanelResizing(true)
            }}
            onPointerMove={(event) => {
              const drag = panelDragRef.current
              if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) adjustPanelWidth(drag.width + drag.x - event.clientX)
            }}
            onLostPointerCapture={() => {
              panelDragRef.current = null
              setPanelResizing(false)
            }}
            onDoubleClick={() => adjustPanelWidth(DEFAULT_PANEL_WIDTH)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                adjustPanelWidth(currentPanelWidth + (event.key === 'ArrowLeft' ? 16 : -16))
              }
            }} />}
          <section className={`terminal-surface ${terminalDocked ? 'terminal-docked' : 'terminal-at-right'}`}
            aria-label="内嵌终端" hidden={!terminalDocked && !showTerminalAtRight}>
            {terminalDocked && <header className="terminal-dock-header">
              <span><Terminal size={14} /> 终端</span>
              <div>
                <button type="button" className="icon-btn" title="移回右侧面板" aria-label="移回右侧面板"
                  onClick={() => openWorkspaceTab('terminal', 'right')}><PanelRightOpen size={15} /></button>
                <button type="button" className="icon-btn" title="关闭底部终端" aria-label="关闭底部终端"
                  onClick={() => setTerminalDocked(false)}><X size={14} /></button>
              </div>
            </header>}
            <div hidden={!effectiveCwd} className="terminal-session"><TerminalPanel cwd={effectiveCwd ?? ''} /></div>
            {!effectiveCwd && <p className="panel-placeholder">请选择一个项目。</p>}
          </section>
        </div>
      </div>

      {showPalette && <CommandPalette entries={paletteEntries} onClose={() => setShowPalette(false)} />}

      {showSettings && (
        <SettingsPage destination={settingsDestination} appearance={appearance} activeHarness={effectiveHarness}
          conversation={conversation} projects={projects} activeProjectId={activeProject?.id ?? null} defaultProjectTrust={defaultProjectTrust}
          harnesses={harnesses} customPaths={customPaths} defaults={harnessDefaults} catalogs={catalogs} catalogLoading={catalogLoading}
          sessionCommands={slashCommands.map((cmd) => cmd.name)}
          sessionEngine={activeThread?.harness ?? activeHarness}
          onInsertToComposer={insertToComposer} onOpenBrowserWindow={openBrowserWindow}
          onNavigate={setSettingsDestination} onSavePath={saveEnginePath} onRefreshHarnesses={refreshHarnessSettings}
          onRefreshCatalog={(id) => loadModelCatalog(id, true)} onSaveDefaults={saveHarnessDefaults} onSaveAppearance={saveAppearance}
          onSaveConversation={saveConversation} onSaveProjectTrust={saveProjectTrust} onSaveDefaultProjectTrust={saveDefaultProjectTrust} />
      )}

      {showShortcuts && <ShortcutsModal enterWhileRunning={conversation.enterWhileRunning} onClose={() => setShowShortcuts(false)} />}

      {trustProjectId && (() => {
        const trustProject = projects.find((p) => p.id === trustProjectId)
        if (!trustProject) return null
        return (
          <ProjectTrustModal
            project={trustProject}
            onClose={() => setTrustProjectId(null)}
            onSave={(preset) => {
              void saveProjectTrust(trustProject.id, preset).then(() => setTrustProjectId(null)).catch(reportError)
            }}
          />
        )
      })()}

      {showForkModal && activeThread && (
        <ForkTreeModal
          activeThread={activeThread}
          allThreads={threads}
          timelines={timelines}
          tree={forkTree}
          loading={forkTreeLoading}
          initialTab={forkModalTab}
          highlightText={forkHighlightText}
          onFork={handleForkThread}
          onSelectThread={selectThread}
          onLoadTimeline={(tid) => {
            void window.agentui.getThreadTimeline(tid).then((items) => {
              setTimelines((prev) => ((prev[tid]?.length ?? 0) > 0 ? prev : { ...prev, [tid]: items }))
            })
          }}
          onRefresh={() => void refreshForkTreeFor(activeThread.id)}
          onClose={() => setShowForkModal(false)}
        />
      )}

      {previewImage && (
        <div className="modal-backdrop" onClick={() => setPreviewImage(null)}>
          <img
            src={`data:${previewImage.mimeType};base64,${previewImage.data}`}
            alt={previewImage.name ?? 'preview'}
            className="image-lightbox"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
