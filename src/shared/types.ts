import type { AppearanceSettings, ConversationSettings, HarnessDefaults } from './settings'
import type { AppDiagnostics } from './diagnostics'
import type {
  AccountQuota,
  EnginePackageSnapshot,
  EngineSkillSnapshot,
  ExtensionEngine,
  McpAddInput,
  McpEngineSnapshot,
  UsageFilters,
  UsageReport,
} from './extensions'

export type { McpAddInput, UsageFilters, ExtensionEngine }

// ---------------------------------------------------------------------------
// 独立浏览器窗口 + 分享到会话
// ---------------------------------------------------------------------------

export interface BrowserWinTabInfo {
  id: string
  title: string
  url: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  favicon?: string
}

export type SharePayloadKind = 'link' | 'text' | 'image'

export interface ShareToThreadInput {
  kind: SharePayloadKind
  url?: string
  title?: string
  text?: string
  imageData?: string
  mimeType?: string
  fromUrl?: string
}

export interface ShareToComposerEvent extends ShareToThreadInput {
  threadId: string
}

export type HarnessId = 'pi' | 'omp' | 'prime' | 'claude' | 'codex' | 'acp' | 'dsh'

export const HARNESS_IDS: readonly HarnessId[] = ['pi', 'omp', 'prime', 'claude', 'codex', 'acp', 'dsh']

export const HARNESS_LABELS: Record<HarnessId, string> = {
  pi: 'Pi',
  omp: 'OMP',
  prime: 'Prime Agent',
  claude: 'Claude Code',
  codex: 'Codex',
  acp: 'ACP',
  dsh: 'dsh',
}

/** Engines whose native wire protocol is bridged into the canonical Pi-style RPC event stream. */
export const BRIDGED_HARNESS_IDS: readonly HarnessId[] = ['claude', 'codex', 'acp', 'dsh']

export function isBridgedHarness(harness: HarnessId): boolean {
  return BRIDGED_HARNESS_IDS.includes(harness)
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export type PrimeImplementation = 'rust' | 'typescript'

export interface HarnessStatus {
  id: HarnessId
  name: string
  path: string | null
  version: string | null
  implementation?: PrimeImplementation
  ready: boolean
  error?: string
  agentDir: string
  sessionRoot: string
}

export interface ModelDescriptor {
  provider: string
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens?: number
  availableThinkingLevels: ThinkingLevel[]
  fastModeSupported?: boolean
}

export interface ModelCatalogResult {
  harness: HarnessId
  models: ModelDescriptor[]
  warning?: string
  fetchedAt: number
}

export interface ProjectEntry {
  id: string
  name: string
  path: string
  addedAt: number
  defaultHarness: HarnessId
  /** Tool-permission preset for this project; defaults to 'approval'. */
  trustPreset?: import('./tool-policy').TrustPreset
}

export type ThreadRunStatus =
  | 'idle'
  | 'starting'
  | 'streaming'
  | 'compacting'
  | 'waiting_ui'
  | 'disconnected'
  | 'error'

export interface RuntimeDisconnectInfo {
  code: number | null
  signal: string | null
  reason: string
  stderrTail?: string
  wasStreaming: boolean
  lastPrompt?: string | null
  disconnectedAt: number
}

export interface ThreadEntry {
  id: string
  projectId: string
  title: string
  harness: HarnessId
  cwd: string
  worktreeBranch?: string | null
  sessionPath?: string | null
  parentThreadId?: string | null
  forkedFromEntryId?: string | null
  modelProvider?: string | null
  modelId?: string | null
  thinkingLevel: ThinkingLevel
  createdAt: number
  updatedAt: number
  status: ThreadRunStatus
  lastError?: string | null
}

export interface ImageAttachment {
  id: string
  type: 'image'
  data: string
  mimeType: string
  name?: string
  sizeBytes?: number
}

export interface WorkspaceFileEntry {
  path: string
  name: string
}

export interface WorkspaceDirEntry {
  name: string
  path: string
  isDirectory: boolean
  sizeBytes?: number
}

export interface WorkspaceFileContent {
  path: string
  content: string
  sizeBytes: number
  truncated: boolean
  binary: boolean
  language?: string
}

export interface TerminalOutputEvent {
  runId: string
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface TerminalExitEvent {
  runId: string
  code: number | null
  signal: string | null
  timedOut: boolean
}

export interface BrowserEgoStatus {
  available: boolean
  path: string | null
  version: string | null
  error?: string
}

export interface BrowserMcpServer {
  name: string
  /** Config file the server was discovered in. */
  source: string
  command?: string
  args?: string[]
  url?: string
  browserLike: boolean
}

export interface BrowserStatus {
  ego: BrowserEgoStatus
  mcpServers: BrowserMcpServer[]
  fetchedAt: number
}

export interface BrowserSpaceInfo {
  id: number
  name: string
  ownership?: string
}

export interface BrowserTabInfo {
  label?: string
  title: string
  url: string
  active: boolean
}

export interface BrowserOpenResult {
  url: string
  title: string
  spaceId: number | null
  /** Tab list captured in the same script round (saves a second ego-browser spawn). */
  tabs?: BrowserTabInfo[]
}

export interface BrowserScreenshotResult {
  data: string
  mimeType: string
  url: string
  title: string
}

export interface SlashCommandDescriptor {
  name: string
  description?: string
  source: 'builtin' | 'extension' | 'prompt' | 'skill'
  argsHint?: string
}

export interface SessionForkMessage {
  entryId: string
  parentId: string | null
  text: string
  timestamp?: number
  assistantPreview?: string
  model?: string
  depth: number
}

export interface SessionTreeSnapshot {
  sessionPath: string | null
  leafId: string | null
  messages: SessionForkMessage[]
  supportsNativeFork: boolean
}

export interface ForkThreadInput {
  threadId: string
  entryId?: string | null
  mode: 'new-thread' | 'in-place'
  harness?: HarnessId
  title?: string
}

export interface ForkThreadResult {
  thread: ThreadEntry
  prefillText?: string
  cancelled?: boolean
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costTotal?: number
}

export interface ContextUsageInfo {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface ToolCallItem {
  id: string
  name: string
  argsText: string
  args?: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  output: string
  isError: boolean
  durationMs?: number
}

export type AssistantPart =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCallId: string }

export type TimelineItem =
  | {
      id: string
      role: 'user'
      text: string
      images?: ImageAttachment[]
      timestamp: number
    }
  | {
      id: string
      role: 'assistant'
      parts: AssistantPart[]
      toolCalls: Record<string, ToolCallItem>
      streaming: boolean
      stopReason?: string
      errorMessage?: string
      model?: string
      usage?: TokenUsage
      timestamp: number
    }
  | {
      id: string
      role: 'notice'
      kind: 'info' | 'warning' | 'error' | 'compaction'
      text: string
      details?: string
      timestamp: number
    }
  | {
      id: string
      role: 'change-summary'
      changes: GitTurnChanges
      timestamp: number
    }

export interface GitTurnChanges {
  files: number
  added: number
  removed: number
}

export interface ExtensionUiRequest {
  id: string
  threadId: string
  method: 'select' | 'confirm' | 'input' | 'editor'
  title: string
  message?: string
  command?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
  /** True when the engine withdrew a previously issued request; the renderer should drop it. */
  dismissed?: boolean
  /** Risk assessment attached by the project trust policy (confirm/select only). */
  risk?: { level: import('./tool-policy').ToolRiskLevel; reasons: string[]; command?: string | null }
  policyPreset?: import('./tool-policy').TrustPreset
}

export interface ExtensionUiResponse {
  id: string
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

export interface GitWorktreeInfo {
  path: string
  head: string
  branch: string | null
  isMain: boolean
  isBare: boolean
  detached: boolean
}

export interface GitFileChange {
  path: string
  oldPath?: string
  indexStatus: string
  worktreeStatus: string
  untracked: boolean
  staged: boolean
}

export interface GitStatusSummary {
  isRepo: boolean
  repoRoot?: string
  branch: string | null
  ahead: number
  behind: number
  changes: GitFileChange[]
  worktrees: GitWorktreeInfo[]
  error?: string
}

export interface CliSessionSummary {
  harness: HarnessId
  sessionPath: string
  sessionId: string
  cwd: string
  title: string
  updatedAt: number
}

export interface PersistedState {
  projects: ProjectEntry[]
  threads: ThreadEntry[]
  customBinaryPaths: Partial<Record<HarnessId, string>>
  appearance: AppearanceSettings
  conversation: ConversationSettings
  defaultProjectTrust: import('./tool-policy').TrustPreset
  harnessDefaults: Partial<Record<HarnessId, HarnessDefaults>>
  activeHarness: HarnessId
  activeProjectId: string | null
  activeThreadId: string | null
}

export interface ThreadEventEnvelope {
  threadId: string
  harness: HarnessId
  event: Record<string, unknown>
}

export interface ThreadStatusUpdate {
  threadId: string
  status: ThreadRunStatus
  updatedAt?: number
  title?: string
  sessionPath?: string | null
  lastError?: string | null
  disconnectInfo?: RuntimeDisconnectInfo | null
  contextUsage?: ContextUsageInfo
  modelProvider?: string | null
  modelId?: string | null
  thinkingLevel?: ThinkingLevel
  statusText?: string | null
}

export interface CreateThreadInput {
  projectId: string
  harness: HarnessId
  title?: string
  cwd?: string
  worktreeBranch?: string | null
  sessionPath?: string | null
  parentThreadId?: string | null
  forkedFromEntryId?: string | null
  modelProvider?: string | null
  modelId?: string | null
  thinkingLevel?: ThinkingLevel
}

export interface SendPromptInput {
  threadId: string
  message: string
  images?: ImageAttachment[]
  streamingBehavior?: 'steer' | 'followUp'
}

export interface AgentUiApi {
  getState(): Promise<PersistedState>
  getDiagnostics(refresh?: boolean): Promise<AppDiagnostics>
  discoverHarnesses(refresh?: boolean): Promise<Record<HarnessId, HarnessStatus>>
  testHarnessPath(harness: HarnessId, binaryPath: string): Promise<HarnessStatus>
  setCustomBinaryPath(harness: HarnessId, binaryPath: string | null): Promise<Record<HarnessId, HarnessStatus>>
  setHarnessDefaults(harness: HarnessId, defaults: HarnessDefaults): Promise<HarnessDefaults>
  setAppearance(patch: Partial<AppearanceSettings>): Promise<AppearanceSettings>
  setConversationSettings(patch: Partial<ConversationSettings>): Promise<ConversationSettings>
  setDefaultProjectTrust(preset: import('./tool-policy').TrustPreset): Promise<import('./tool-policy').TrustPreset>
  setActiveHarness(harness: HarnessId): Promise<void>
  getModelCatalog(harness: HarnessId, refresh?: boolean): Promise<ModelCatalogResult>
  pickDirectory(): Promise<string | null>
  pickExecutable(): Promise<string | null>
  addProject(dirPath: string): Promise<ProjectEntry>
  removeProject(projectId: string): Promise<void>
  setActiveProject(projectId: string | null): Promise<void>
  setProjectTrust(projectId: string, preset: import('./tool-policy').TrustPreset): Promise<ProjectEntry>
  createThread(input: CreateThreadInput): Promise<ThreadEntry>
  deleteThread(threadId: string): Promise<void>
  setActiveThread(threadId: string | null): Promise<void>
  updateThreadMeta(threadId: string, patch: Partial<Pick<ThreadEntry, 'title' | 'harness' | 'modelProvider' | 'modelId' | 'thinkingLevel'>>): Promise<ThreadEntry>
  getThreadTimeline(threadId: string): Promise<TimelineItem[]>
  getThreadTurnDiff(threadId: string, summaryId: string): Promise<string | null>
  sendPrompt(input: SendPromptInput): Promise<void>
  abortThread(threadId: string): Promise<void>
  reconnectThread(threadId: string): Promise<void>
  retryLastPrompt(threadId: string): Promise<void>
  setThreadModel(threadId: string, provider: string, modelId: string): Promise<void>
  setThreadThinking(threadId: string, level: ThinkingLevel): Promise<void>
  compactThread(threadId: string): Promise<void>
  respondExtensionUi(threadId: string, response: ExtensionUiResponse): Promise<void>
  listWorkspaceFiles(cwd: string, query?: string): Promise<WorkspaceFileEntry[]>
  listWorkspaceDir(cwd: string, relPath?: string): Promise<WorkspaceDirEntry[]>
  readWorkspaceFile(cwd: string, relPath: string): Promise<WorkspaceFileContent>
  terminalStart(cwd: string, command: string): Promise<string>
  terminalStop(runId: string): Promise<void>
  onTerminalOutput(cb: (event: TerminalOutputEvent) => void): () => void
  onTerminalExit(cb: (event: TerminalExitEvent) => void): () => void
  browserStatus(refresh?: boolean): Promise<BrowserStatus>
  browserSpaces(): Promise<BrowserSpaceInfo[]>
  browserTabs(): Promise<BrowserTabInfo[]>
  browserOpen(url: string): Promise<BrowserOpenResult>
  browserActivateTab(label: string): Promise<BrowserTabInfo[]>
  browserScreenshot(): Promise<BrowserScreenshotResult>
  getThreadCommands(threadId: string): Promise<SlashCommandDescriptor[]>
  getThreadForkTree(threadId: string): Promise<SessionTreeSnapshot>
  forkThread(input: ForkThreadInput): Promise<ForkThreadResult>
  listCliSessions(harness?: HarnessId): Promise<CliSessionSummary[]>
  gitGetStatus(cwd: string): Promise<GitStatusSummary>
  gitGetDiff(cwd: string, filePath?: string, staged?: boolean): Promise<string>
  gitStageFile(cwd: string, filePath: string): Promise<void>
  gitUnstageFile(cwd: string, filePath: string): Promise<void>
  gitDiscardFile(cwd: string, filePath: string, untracked?: boolean): Promise<void>
  gitCommit(cwd: string, message: string): Promise<void>
  gitCreateWorktree(repoPath: string, branchName: string, baseRef?: string): Promise<GitWorktreeInfo>
  gitRemoveWorktree(repoPath: string, worktreePath: string, force?: boolean): Promise<void>
  onThreadEvent(cb: (envelope: ThreadEventEnvelope) => void): () => void
  onThreadStatus(cb: (update: ThreadStatusUpdate) => void): () => void
  onExtensionUiRequest(cb: (req: ExtensionUiRequest) => void): () => void

  // ── 设置：MCP / 插件 / 技能 / 使用情况 ──
  getEngineMcp(engine: ExtensionEngine, projectPath?: string | null): Promise<McpEngineSnapshot>
  mcpAddServer(input: McpAddInput, projectPath?: string | null): Promise<McpEngineSnapshot>
  mcpRemoveServer(engine: ExtensionEngine, scope: 'user' | 'project', name: string, projectPath?: string | null): Promise<McpEngineSnapshot>
  mcpCheckLive(engine: ExtensionEngine, projectPath?: string | null): Promise<McpEngineSnapshot>
  getEnginePackages(engine: ExtensionEngine, projectPath?: string | null): Promise<EnginePackageSnapshot>
  packageInstall(engine: ExtensionEngine, source: string, scope: 'user' | 'project', projectPath?: string | null): Promise<EnginePackageSnapshot>
  packageRemove(engine: ExtensionEngine, name: string, scope: 'user' | 'project', projectPath?: string | null): Promise<EnginePackageSnapshot>
  packageUpdate(engine: ExtensionEngine, name: string | null, scope: 'user' | 'project', projectPath?: string | null): Promise<EnginePackageSnapshot>
  getEngineSkills(engine: ExtensionEngine, projectPath?: string | null): Promise<EngineSkillSnapshot>
  readSkillFile(filePath: string): Promise<{ path: string; content: string; truncated: boolean }>
  getUsageReport(filters?: UsageFilters, refresh?: boolean): Promise<UsageReport>

  // ── 独立浏览器窗口 ──
  browserWindowShow(): Promise<void>
  browserWindowIsOpen(): Promise<boolean>
  browserWinCreateTab(url?: string): Promise<BrowserWinTabInfo[]>
  browserWinCloseTab(tabId: string): Promise<BrowserWinTabInfo[]>
  browserWinActivateTab(tabId: string): Promise<BrowserWinTabInfo[]>
  browserWinNavigate(url: string): Promise<BrowserWinTabInfo[]>
  browserWinGoBack(): Promise<BrowserWinTabInfo[]>
  browserWinGoForward(): Promise<BrowserWinTabInfo[]>
  browserWinReload(): Promise<BrowserWinTabInfo[]>
  browserWinStop(): Promise<BrowserWinTabInfo[]>
  browserWinSetInsets(top: number): Promise<void>
  browserWinShare(target: { threadId: string; kind: SharePayloadKind }): Promise<void>
  onBrowserWinTabs(cb: (tabs: BrowserWinTabInfo[]) => void): () => void
  onShareToComposer(cb: (event: ShareToComposerEvent) => void): () => void
}
