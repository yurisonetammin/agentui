export type HarnessId = 'pi' | 'omp' | 'prime'

export const HARNESS_IDS: readonly HarnessId[] = ['pi', 'omp', 'prime']

export const HARNESS_LABELS: Record<HarnessId, string> = {
  pi: 'Pi',
  omp: 'OMP',
  prime: 'Prime Agent',
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
  modelProvider?: string | null
  modelId?: string | null
  thinkingLevel: ThinkingLevel
  createdAt: number
  updatedAt: number
  status: ThreadRunStatus
  lastError?: string | null
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
      timestamp: number
    }

export interface ExtensionUiRequest {
  id: string
  threadId: string
  method: 'select' | 'confirm' | 'input' | 'editor'
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
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
  modelProvider?: string | null
  modelId?: string | null
  thinkingLevel?: ThinkingLevel
}

export interface SendPromptInput {
  threadId: string
  message: string
  streamingBehavior?: 'steer' | 'followUp'
}

export interface AgentUiApi {
  getState(): Promise<PersistedState>
  discoverHarnesses(refresh?: boolean): Promise<Record<HarnessId, HarnessStatus>>
  setCustomBinaryPath(harness: HarnessId, binaryPath: string | null): Promise<Record<HarnessId, HarnessStatus>>
  setActiveHarness(harness: HarnessId): Promise<void>
  getModelCatalog(harness: HarnessId, refresh?: boolean): Promise<ModelCatalogResult>
  pickDirectory(): Promise<string | null>
  addProject(dirPath: string): Promise<ProjectEntry>
  removeProject(projectId: string): Promise<void>
  setActiveProject(projectId: string | null): Promise<void>
  createThread(input: CreateThreadInput): Promise<ThreadEntry>
  deleteThread(threadId: string): Promise<void>
  setActiveThread(threadId: string | null): Promise<void>
  updateThreadMeta(threadId: string, patch: Partial<Pick<ThreadEntry, 'title' | 'harness' | 'modelProvider' | 'modelId' | 'thinkingLevel'>>): Promise<ThreadEntry>
  getThreadTimeline(threadId: string): Promise<TimelineItem[]>
  sendPrompt(input: SendPromptInput): Promise<void>
  abortThread(threadId: string): Promise<void>
  reconnectThread(threadId: string): Promise<void>
  retryLastPrompt(threadId: string): Promise<void>
  setThreadModel(threadId: string, provider: string, modelId: string): Promise<void>
  setThreadThinking(threadId: string, level: ThinkingLevel): Promise<void>
  compactThread(threadId: string): Promise<void>
  respondExtensionUi(threadId: string, response: ExtensionUiResponse): Promise<void>
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
}
