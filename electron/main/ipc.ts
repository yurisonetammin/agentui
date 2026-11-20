import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import {
  HARNESS_IDS,
  type CreateThreadInput,
  type ExtensionUiResponse,
  type ForkThreadInput,
  type HarnessId,
  type SendPromptInput,
  type ThinkingLevel,
  type ThreadEntry,
} from '@shared/types'
import type { HarnessDiscoveryService } from './discovery'
import type { GitService } from './git/git-service'
import type { ModelCatalogService } from './model-catalog'
import type { RuntimeManager } from './rpc/manager'
import { scanCliSessions } from './sessions/catalog'
import type { StateStore } from './store'
import type { WorkspaceFileService } from './workspace-files'

export function registerIpcHandlers(deps: {
  getWindow: () => BrowserWindow | null
  store: StateStore
  discovery: HarnessDiscoveryService
  models: ModelCatalogService
  git: GitService
  workspaceFiles: WorkspaceFileService
  runtimeManager: RuntimeManager
}): void {
  const { getWindow, store, discovery, models, git, workspaceFiles, runtimeManager } = deps

  ipcMain.handle('app:getState', () => store.snapshot())

  ipcMain.handle('harnesses:discover', async (_e, refresh?: boolean) => {
    if (refresh === false) return discovery.snapshot()
    return discovery.refresh(store.snapshot().customBinaryPaths)
  })

  ipcMain.handle('harnesses:setCustomPath', async (_e, harness: HarnessId, binaryPath: string | null) => {
    store.mutate((draft) => {
      if (!binaryPath || !binaryPath.trim()) {
        delete draft.customBinaryPaths[harness]
      } else {
        draft.customBinaryPaths[harness] = binaryPath.trim()
      }
    })
    return discovery.refresh(store.snapshot().customBinaryPaths)
  })

  ipcMain.handle('harnesses:setActive', (_e, harness: HarnessId) => {
    store.mutate((draft) => {
      draft.activeHarness = harness
    })
  })

  ipcMain.handle('models:catalog', (_e, harness: HarnessId, refresh?: boolean) => {
    return models.getCatalog(harness, refresh === true)
  })

  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('projects:add', (_e, dirPath: string) => {
    const abs = resolve(dirPath.trim())
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`目录不存在: ${abs}`)
    }
    const existing = store.snapshot().projects.find((p) => p.path.toLowerCase() === abs.toLowerCase())
    if (existing) {
      store.mutate((draft) => {
        draft.activeProjectId = existing.id
      })
      return existing
    }
    const project = {
      id: randomUUID(),
      name: basename(abs) || abs,
      path: abs,
      addedAt: Date.now(),
      defaultHarness: store.snapshot().activeHarness,
    }
    store.mutate((draft) => {
      draft.projects.push(project)
      draft.activeProjectId = project.id
    })
    return project
  })

  ipcMain.handle('projects:remove', async (_e, projectId: string) => {
    const threads = store.snapshot().threads.filter((t) => t.projectId === projectId)
    await Promise.all(threads.map((t) => runtimeManager.removeThread(t.id)))
    store.mutate((draft) => {
      draft.projects = draft.projects.filter((p) => p.id !== projectId)
      draft.threads = draft.threads.filter((t) => t.projectId !== projectId)
      if (draft.activeProjectId === projectId) {
        draft.activeProjectId = draft.projects[0]?.id ?? null
      }
      if (draft.activeThreadId && !draft.threads.some((t) => t.id === draft.activeThreadId)) {
        draft.activeThreadId = draft.threads[0]?.id ?? null
      }
    })
  })

  ipcMain.handle('projects:setActive', (_e, projectId: string | null) => {
    store.mutate((draft) => {
      draft.activeProjectId = projectId
    })
  })

  ipcMain.handle('threads:create', (_e, input: CreateThreadInput) => {
    const state = store.snapshot()
    const project = state.projects.find((p) => p.id === input.projectId)
    if (!project) throw new Error('所属项目不存在')
    const cwd = input.cwd ? resolve(input.cwd) : project.path
    if (!existsSync(cwd)) throw new Error(`工作目录不存在: ${cwd}`)

    const now = Date.now()
    const thread: ThreadEntry = {
      id: randomUUID(),
      projectId: project.id,
      title: input.title?.trim() || '新对话',
      harness: input.harness,
      cwd,
      worktreeBranch: input.worktreeBranch ?? null,
      sessionPath: input.sessionPath ?? null,
      parentThreadId: input.parentThreadId ?? null,
      forkedFromEntryId: input.forkedFromEntryId ?? null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      thinkingLevel: input.thinkingLevel ?? 'medium',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      lastError: null,
    }
    store.mutate((draft) => {
      draft.threads.unshift(thread)
      draft.activeThreadId = thread.id
      draft.activeProjectId = project.id
      draft.activeHarness = thread.harness
    })
    return thread
  })

  ipcMain.handle('threads:delete', async (_e, threadId: string) => {
    await runtimeManager.removeThread(threadId)
    store.mutate((draft) => {
      draft.threads = draft.threads.filter((t) => t.id !== threadId)
      if (draft.activeThreadId === threadId) {
        draft.activeThreadId = draft.threads[0]?.id ?? null
      }
    })
  })

  ipcMain.handle('threads:setActive', (_e, threadId: string | null) => {
    store.mutate((draft) => {
      draft.activeThreadId = threadId
    })
  })

  ipcMain.handle('threads:updateMeta', (_e, threadId: string, patch: Partial<Pick<ThreadEntry, 'title' | 'harness' | 'modelProvider' | 'modelId' | 'thinkingLevel'>>) => {
    let updated: ThreadEntry | undefined
    store.mutate((draft) => {
      const target = draft.threads.find((t) => t.id === threadId)
      if (!target) return
      if (typeof patch.title === 'string') target.title = patch.title
      if (patch.harness && !target.sessionPath && target.status === 'idle' && runtimeManager.getTimeline(threadId).length === 0) {
        target.harness = patch.harness
        target.modelProvider = null
        target.modelId = null
        draft.activeHarness = patch.harness
      }
      if (patch.modelProvider !== undefined) target.modelProvider = patch.modelProvider
      if (patch.modelId !== undefined) target.modelId = patch.modelId
      if (patch.thinkingLevel !== undefined) target.thinkingLevel = patch.thinkingLevel
      target.updatedAt = Date.now()
      updated = structuredClone(target)
    })
    if (!updated) throw new Error('会话不存在')
    return updated
  })

  ipcMain.handle('threads:getTimeline', (_e, threadId: string) => {
    return runtimeManager.getTimeline(threadId)
  })

  ipcMain.handle('threads:sendPrompt', (_e, input: SendPromptInput) => {
    return runtimeManager.sendPrompt(input)
  })

  ipcMain.handle('threads:abort', (_e, threadId: string) => {
    return runtimeManager.abort(threadId)
  })

  ipcMain.handle('threads:reconnect', (_e, threadId: string) => {
    return runtimeManager.reconnect(threadId)
  })

  ipcMain.handle('threads:retryLastPrompt', (_e, threadId: string) => {
    return runtimeManager.retryLastPrompt(threadId)
  })

  ipcMain.handle('threads:setModel', (_e, threadId: string, provider: string, modelId: string) => {
    return runtimeManager.setModel(threadId, provider, modelId)
  })

  ipcMain.handle('threads:setThinking', (_e, threadId: string, level: ThinkingLevel) => {
    return runtimeManager.setThinkingLevel(threadId, level)
  })

  ipcMain.handle('threads:compact', (_e, threadId: string) => {
    return runtimeManager.compact(threadId)
  })

  ipcMain.handle('threads:respondUi', (_e, threadId: string, response: ExtensionUiResponse) => {
    return runtimeManager.respondExtensionUi(threadId, response)
  })

  ipcMain.handle('workspace:listFiles', (_e, cwd: string, query?: string) => {
    return workspaceFiles.listFiles(cwd, query ?? '')
  })

  ipcMain.handle('threads:getCommands', (_e, threadId: string) => {
    return runtimeManager.getSlashCommands(threadId)
  })

  ipcMain.handle('threads:getForkTree', (_e, threadId: string) => {
    return runtimeManager.getForkTree(threadId)
  })

  ipcMain.handle('threads:fork', (_e, input: ForkThreadInput) => {
    return runtimeManager.forkThread(input)
  })

  ipcMain.handle('sessions:listCli', (_e, harness?: HarnessId) => {
    const statuses = discovery.snapshot()
    const targets = harness ? [harness] : HARNESS_IDS
    return targets
      .flatMap((id) => scanCliSessions(id, statuses[id].sessionRoot, 25))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40)
  })

  ipcMain.handle('git:status', (_e, cwd: string) => git.getStatus(cwd))
  ipcMain.handle('git:diff', (_e, cwd: string, filePath?: string, staged?: boolean) => git.getDiff(cwd, filePath, staged))
  ipcMain.handle('git:stage', (_e, cwd: string, filePath: string) => git.stageFile(cwd, filePath))
  ipcMain.handle('git:unstage', (_e, cwd: string, filePath: string) => git.unstageFile(cwd, filePath))
  ipcMain.handle('git:discard', (_e, cwd: string, filePath: string, untracked?: boolean) => git.discardFile(cwd, filePath, untracked))
  ipcMain.handle('git:commit', (_e, cwd: string, message: string) => git.commit(cwd, message))
  ipcMain.handle('git:createWorktree', (_e, repoPath: string, branchName: string, baseRef?: string) => git.createWorktree(repoPath, branchName, baseRef))
  ipcMain.handle('git:removeWorktree', (_e, repoPath: string, worktreePath: string, force?: boolean) => git.removeWorktree(repoPath, worktreePath, force))
}
