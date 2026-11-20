import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentUiApi,
  CreateThreadInput,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ForkThreadInput,
  HarnessId,
  SendPromptInput,
  ThinkingLevel,
  ThreadEntry,
  ThreadEventEnvelope,
  ThreadStatusUpdate,
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AgentUiApi = {
  getState: () => ipcRenderer.invoke('app:getState'),
  discoverHarnesses: (refresh?: boolean) => ipcRenderer.invoke('harnesses:discover', refresh),
  setCustomBinaryPath: (harness: HarnessId, binaryPath: string | null) =>
    ipcRenderer.invoke('harnesses:setCustomPath', harness, binaryPath),
  setActiveHarness: (harness: HarnessId) => ipcRenderer.invoke('harnesses:setActive', harness),
  getModelCatalog: (harness: HarnessId, refresh?: boolean) => ipcRenderer.invoke('models:catalog', harness, refresh),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  addProject: (dirPath: string) => ipcRenderer.invoke('projects:add', dirPath),
  removeProject: (projectId: string) => ipcRenderer.invoke('projects:remove', projectId),
  setActiveProject: (projectId: string | null) => ipcRenderer.invoke('projects:setActive', projectId),
  createThread: (input: CreateThreadInput) => ipcRenderer.invoke('threads:create', input),
  deleteThread: (threadId: string) => ipcRenderer.invoke('threads:delete', threadId),
  setActiveThread: (threadId: string | null) => ipcRenderer.invoke('threads:setActive', threadId),
  updateThreadMeta: (threadId: string, patch: Partial<Pick<ThreadEntry, 'title' | 'harness' | 'modelProvider' | 'modelId' | 'thinkingLevel'>>) =>
    ipcRenderer.invoke('threads:updateMeta', threadId, patch),
  getThreadTimeline: (threadId: string) => ipcRenderer.invoke('threads:getTimeline', threadId),
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
}

contextBridge.exposeInMainWorld('agentui', api)
