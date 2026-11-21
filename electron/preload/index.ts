import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentUiApi,
  BrowserWinTabInfo,
  CreateThreadInput,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ForkThreadInput,
  HarnessId,
  McpAddInput,
  SendPromptInput,
  SharePayloadKind,
  ShareToComposerEvent,
  ThinkingLevel,
  ThreadEntry,
  ThreadEventEnvelope,
  ThreadStatusUpdate,
  UsageFilters,
} from '@shared/types'
import type { ExtensionEngine } from '@shared/extensions'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AgentUiApi = {
  getState: () => ipcRenderer.invoke('app:getState'),
  getDiagnostics: (refresh) => ipcRenderer.invoke('app:getDiagnostics', refresh),
  discoverHarnesses: (refresh?: boolean) => ipcRenderer.invoke('harnesses:discover', refresh),
  testHarnessPath: (harness, path) => ipcRenderer.invoke('harnesses:testPath', harness, path),
  setCustomBinaryPath: (harness: HarnessId, binaryPath: string | null) =>
    ipcRenderer.invoke('harnesses:setCustomPath', harness, binaryPath),
  setActiveHarness: (harness: HarnessId) => ipcRenderer.invoke('harnesses:setActive', harness),
  setHarnessDefaults: (harness, defaults) => ipcRenderer.invoke('settings:setHarnessDefaults', harness, defaults),
  setAppearance: (patch) => ipcRenderer.invoke('settings:setAppearance', patch),
  setConversationSettings: (patch) => ipcRenderer.invoke('settings:setConversation', patch),
  setDefaultProjectTrust: (preset) => ipcRenderer.invoke('settings:setDefaultProjectTrust', preset),
  getModelCatalog: (harness: HarnessId, refresh?: boolean) => ipcRenderer.invoke('models:catalog', harness, refresh),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  addProject: (dirPath: string) => ipcRenderer.invoke('projects:add', dirPath),
  removeProject: (projectId: string) => ipcRenderer.invoke('projects:remove', projectId),
  setActiveProject: (projectId: string | null) => ipcRenderer.invoke('projects:setActive', projectId),
  setProjectTrust: (projectId, preset) => ipcRenderer.invoke('projects:setTrust', projectId, preset),
  createThread: (input: CreateThreadInput) => ipcRenderer.invoke('threads:create', input),
  deleteThread: (threadId: string) => ipcRenderer.invoke('threads:delete', threadId),
  setActiveThread: (threadId: string | null) => ipcRenderer.invoke('threads:setActive', threadId),
  updateThreadMeta: (threadId: string, patch: Partial<Pick<ThreadEntry, 'title' | 'harness' | 'modelProvider' | 'modelId' | 'thinkingLevel'>>) =>
    ipcRenderer.invoke('threads:updateMeta', threadId, patch),
  getThreadTimeline: (threadId: string) => ipcRenderer.invoke('threads:getTimeline', threadId),
  getThreadTurnDiff: (threadId: string, summaryId: string) => ipcRenderer.invoke('threads:getTurnDiff', threadId, summaryId),
  sendPrompt: (input: SendPromptInput) => ipcRenderer.invoke('threads:sendPrompt', input),
  abortThread: (threadId: string) => ipcRenderer.invoke('threads:abort', threadId),
  reconnectThread: (threadId: string) => ipcRenderer.invoke('threads:reconnect', threadId),
  retryLastPrompt: (threadId: string) => ipcRenderer.invoke('threads:retryLastPrompt', threadId),
  setThreadModel: (threadId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke('threads:setModel', threadId, provider, modelId),
  setThreadThinking: (threadId: string, level: ThinkingLevel) => ipcRenderer.invoke('threads:setThinking', threadId, level),
  compactThread: (threadId: string) => ipcRenderer.invoke('threads:compact', threadId),
  respondExtensionUi: (threadId: string, response: ExtensionUiResponse) =>
    ipcRenderer.invoke('threads:respondUi', threadId, response),
  listWorkspaceFiles: (cwd: string, query?: string) => ipcRenderer.invoke('workspace:listFiles', cwd, query),
  listWorkspaceDir: (cwd: string, relPath?: string) => ipcRenderer.invoke('workspace:listDir', cwd, relPath),
  readWorkspaceFile: (cwd: string, relPath: string) => ipcRenderer.invoke('workspace:readFile', cwd, relPath),
  terminalStart: (cwd: string, command: string) => ipcRenderer.invoke('terminal:start', cwd, command),
  terminalStop: (runId: string) => ipcRenderer.invoke('terminal:stop', runId),
  browserStatus: (refresh?: boolean) => ipcRenderer.invoke('browser:status', refresh),
  browserSpaces: () => ipcRenderer.invoke('browser:spaces'),
  browserTabs: () => ipcRenderer.invoke('browser:tabs'),
  browserOpen: (url: string) => ipcRenderer.invoke('browser:open', url),
  browserActivateTab: (label: string) => ipcRenderer.invoke('browser:activateTab', label),
  browserScreenshot: () => ipcRenderer.invoke('browser:screenshot'),
  getThreadCommands: (threadId: string) => ipcRenderer.invoke('threads:getCommands', threadId),
  getThreadForkTree: (threadId: string) => ipcRenderer.invoke('threads:getForkTree', threadId),
  forkThread: (input: ForkThreadInput) => ipcRenderer.invoke('threads:fork', input),
  listCliSessions: (harness?: HarnessId) => ipcRenderer.invoke('sessions:listCli', harness),
  gitGetStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  gitGetDiff: (cwd: string, filePath?: string, staged?: boolean) => ipcRenderer.invoke('git:diff', cwd, filePath, staged),
  gitStageFile: (cwd: string, filePath: string) => ipcRenderer.invoke('git:stage', cwd, filePath),
  gitUnstageFile: (cwd: string, filePath: string) => ipcRenderer.invoke('git:unstage', cwd, filePath),
  gitDiscardFile: (cwd: string, filePath: string, untracked?: boolean) =>
    ipcRenderer.invoke('git:discard', cwd, filePath, untracked),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),
  gitCreateWorktree: (repoPath: string, branchName: string, baseRef?: string) =>
    ipcRenderer.invoke('git:createWorktree', repoPath, branchName, baseRef),
  gitRemoveWorktree: (repoPath: string, worktreePath: string, force?: boolean) =>
    ipcRenderer.invoke('git:removeWorktree', repoPath, worktreePath, force),
  onThreadEvent: (cb: (envelope: ThreadEventEnvelope) => void) => subscribe('agentui:threadEvent', cb),
  onThreadStatus: (cb: (update: ThreadStatusUpdate) => void) => subscribe('agentui:threadStatus', cb),
  onExtensionUiRequest: (cb: (req: ExtensionUiRequest) => void) => subscribe('agentui:extensionUiRequest', cb),
  onTerminalOutput: (cb) => subscribe('agentui:terminalOutput', cb),
  onTerminalExit: (cb) => subscribe('agentui:terminalExit', cb),

  // ── 设置：MCP / 插件 / 技能 / 使用情况 ──
  getEngineMcp: (engine: ExtensionEngine, projectPath?: string | null) =>
    ipcRenderer.invoke('ext:getMcp', engine, projectPath ?? null),
  mcpAddServer: (input: McpAddInput, projectPath?: string | null) =>
    ipcRenderer.invoke('ext:mcpAdd', input, projectPath ?? null),
  mcpRemoveServer: (engine: ExtensionEngine, scope: 'user' | 'project', name: string, projectPath?: string | null) =>
    ipcRenderer.invoke('ext:mcpRemove', engine, scope, name, projectPath ?? null),
  mcpCheckLive: (engine: ExtensionEngine, projectPath?: string | null) =>
    ipcRenderer.invoke('ext:mcpCheckLive', engine, projectPath ?? null),
  getEnginePackages: (engine: ExtensionEngine, projectPath?: string | null) =>
    ipcRenderer.invoke('ext:getPackages', engine, projectPath ?? null),
  packageInstall: (engine: ExtensionEngine, source: string, scope: 'user' | 'project', projectPath?: string | null) =>
    ipcRenderer.invoke('ext:packageInstall', engine, source, scope, projectPath ?? null),
  packageRemove: (engine: ExtensionEngine, name: string, scope: 'user' | 'project', projectPath?: string | null) =>
    ipcRenderer.invoke('ext:packageRemove', engine, name, scope, projectPath ?? null),
  packageUpdate: (engine: ExtensionEngine, name: string | null, scope: 'user' | 'project', projectPath?: string | null) =>
    ipcRenderer.invoke('ext:packageUpdate', engine, name ?? null, scope, projectPath ?? null),
  getEngineSkills: (engine: ExtensionEngine, projectPath?: string | null) =>
    ipcRenderer.invoke('ext:getSkills', engine, projectPath ?? null),
  readSkillFile: (filePath: string) => ipcRenderer.invoke('ext:readSkill', filePath),
  getUsageReport: (filters?: UsageFilters, refresh?: boolean) =>
    ipcRenderer.invoke('usage:getReport', filters ?? {}, refresh === true),

  // ── 独立浏览器窗口 ──
  browserWindowShow: () => ipcRenderer.invoke('browserWin:show'),
  browserWindowIsOpen: () => ipcRenderer.invoke('browserWin:isOpen'),
  browserWinCreateTab: (url?: string) => ipcRenderer.invoke('browserWin:createTab', url) as Promise<BrowserWinTabInfo[]>,
  browserWinCloseTab: (tabId: string) => ipcRenderer.invoke('browserWin:closeTab', tabId) as Promise<BrowserWinTabInfo[]>,
  browserWinActivateTab: (tabId: string) => ipcRenderer.invoke('browserWin:activateTab', tabId) as Promise<BrowserWinTabInfo[]>,
  browserWinNavigate: (url: string) => ipcRenderer.invoke('browserWin:navigate', url) as Promise<BrowserWinTabInfo[]>,
  browserWinGoBack: () => ipcRenderer.invoke('browserWin:back') as Promise<BrowserWinTabInfo[]>,
  browserWinGoForward: () => ipcRenderer.invoke('browserWin:forward') as Promise<BrowserWinTabInfo[]>,
  browserWinReload: () => ipcRenderer.invoke('browserWin:reload') as Promise<BrowserWinTabInfo[]>,
  browserWinStop: () => ipcRenderer.invoke('browserWin:stop') as Promise<BrowserWinTabInfo[]>,
  browserWinSetInsets: (top: number) => ipcRenderer.invoke('browserWin:setInsets', top),
  browserWinShare: (target: { threadId: string; kind: SharePayloadKind }) => ipcRenderer.invoke('browserWin:share', target),
  onBrowserWinTabs: (cb: (tabs: BrowserWinTabInfo[]) => void) => subscribe('agentui:browserWinTabs', cb),
  onShareToComposer: (cb: (event: ShareToComposerEvent) => void) => subscribe('agentui:shareToComposer', cb),
}

contextBridge.exposeInMainWorld('agentui', api)
