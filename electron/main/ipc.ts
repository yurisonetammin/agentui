import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { release } from 'node:os'
import { basename, resolve } from 'node:path'
import { app, dialog, ipcMain, nativeTheme, type BrowserWindow } from 'electron'
import type { AppDiagnostics } from '@shared/diagnostics'
import { normalizeAppearance, normalizeConversation, normalizeHarnessDefaults, type AppearanceSettings, type ConversationSettings, type HarnessDefaults } from '@shared/settings'
import {
  HARNESS_IDS,
  type CreateThreadInput,
  type ExtensionUiResponse,
  type ForkThreadInput,
  type HarnessId,
  type ProjectEntry,
  type SendPromptInput,
  type ThinkingLevel,
  type ThreadEntry,
} from '@shared/types'
import { isTrustPreset } from '@shared/tool-policy'
import { isExtensionEngine, type ExtensionEngine, type McpAddInput, type UsageFilters } from '@shared/extensions'
import type { HarnessDiscoveryService } from './discovery'
import type { BrowserCompanionService } from './browser-companion'
import type { BrowserWindowService } from './browser-window-service'
import type { EngineMcpService } from './extensions/mcp-service'
import type { EnginePackageService } from './extensions/package-service'
import type { EngineSkillService } from './extensions/skill-service'
import type { GitService } from './git/git-service'
import type { ModelCatalogService } from './model-catalog'
import type { RuntimeManager } from './rpc/manager'
import { scanCliSessions } from './sessions/catalog'
import type { StateStore } from './store'
import type { TerminalService } from './terminal-service'
import type { UsageService } from './usage-service'
import type { WorkspaceBrowserService } from './workspace-browser'
import type { WorkspaceFileService } from './workspace-files'

export function registerIpcHandlers(deps: {
  getWindow: () => BrowserWindow | null
  store: StateStore
  discovery: HarnessDiscoveryService
  models: ModelCatalogService
  git: GitService
  workspaceFiles: WorkspaceFileService
  workspaceBrowser: WorkspaceBrowserService
  browserCompanion: BrowserCompanionService
  browserWindow: BrowserWindowService
  engineMcp: EngineMcpService
  enginePackages: EnginePackageService
  engineSkills: EngineSkillService
  usage: UsageService
  terminal: TerminalService
  runtimeManager: RuntimeManager
}): void {
  const {
    getWindow, store, discovery, models, git, workspaceFiles, workspaceBrowser,
    browserCompanion, browserWindow, engineMcp, enginePackages, engineSkills, usage, terminal, runtimeManager,
  } = deps
  const pendingPathUpdates = new Map<HarnessId, symbol>()

  ipcMain.handle('app:getState', () => store.snapshot())

  ipcMain.handle('app:getDiagnostics', async (_e, refresh?: boolean): Promise<AppDiagnostics> => {
    const [harnesses, browserStatus] = await Promise.all([
      refresh === true ? discovery.refresh(store.snapshot().customBinaryPaths) : discovery.snapshot(),
      browserCompanion.getStatus(refresh === true).catch(() => null),
    ])
    const browserMcpCount = browserStatus?.mcpServers.filter((server) => server.browserLike).length ?? 0
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      harnesses,
      startupIssues: runtimeManager.getStartupIssues(),
      browser: browserStatus ? {
        available: browserStatus.ego.available,
        version: browserStatus.ego.version,
        browserMcpCount,
        otherMcpCount: browserStatus.mcpServers.length - browserMcpCount,
      } : null,
      checkedAt: Date.now(),
    }
  })

  ipcMain.handle('harnesses:discover', async (_e, refresh?: boolean) => {
    if (refresh === false) return discovery.snapshot()
    return discovery.refresh(store.snapshot().customBinaryPaths)
  })

  ipcMain.handle('harnesses:testPath', (_e, harness: HarnessId, binaryPath: string) => {
    if (!HARNESS_IDS.includes(harness) || typeof binaryPath !== 'string') throw new Error('无效的引擎或路径')
    return discovery.probe(harness, binaryPath.trim())
  })

  ipcMain.handle('harnesses:setCustomPath', async (_e, harness: HarnessId, binaryPath: string | null) => {
    if (!HARNESS_IDS.includes(harness) || (binaryPath !== null && typeof binaryPath !== 'string')) {
      throw new Error('无效的引擎或路径')
    }
    const path = binaryPath?.trim() || undefined
    const update = Symbol()
    pendingPathUpdates.set(harness, update)
    try {
      const status = await discovery.probe(harness, path)
      if (path && !status.ready) throw new Error(status.error ?? '路径检测失败')
      if (pendingPathUpdates.get(harness) !== update) throw new Error('已有更新的路径操作')
      store.mutate((draft) => {
        if (path) draft.customBinaryPaths[harness] = path
        else delete draft.customBinaryPaths[harness]
      })
      return discovery.applyProbe(status)
    } finally {
      if (pendingPathUpdates.get(harness) === update) pendingPathUpdates.delete(harness)
    }
  })

  ipcMain.handle('settings:setAppearance', (_e, patch: Partial<AppearanceSettings>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的外观设置')
    const appearance = normalizeAppearance({ ...store.snapshot().appearance, ...patch })
    if (Object.entries(patch).some(([key, value]) => appearance[key as keyof AppearanceSettings] !== value)) {
      throw new Error('无效的外观设置')
    }
    store.mutate((draft) => { draft.appearance = appearance })
    nativeTheme.themeSource = appearance.theme
    return appearance
  })

  ipcMain.handle('settings:setConversation', (_e, patch: Partial<ConversationSettings>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的会话设置')
    const conversation = normalizeConversation({ ...store.snapshot().conversation, ...patch })
    if (Object.entries(patch).some(([key, value]) => conversation[key as keyof ConversationSettings] !== value)) {
      throw new Error('无效的会话设置')
    }
    store.mutate((draft) => { draft.conversation = conversation })
    return conversation
  })

  ipcMain.handle('settings:setDefaultProjectTrust', (_e, preset: unknown) => {
    if (!isTrustPreset(preset)) throw new Error('无效的新项目权限预设')
    return store.mutate((draft) => { draft.defaultProjectTrust = preset }).defaultProjectTrust
  })

  ipcMain.handle('settings:setHarnessDefaults', (_e, harness: HarnessId, input: HarnessDefaults) => {
    if (!HARNESS_IDS.includes(harness) || !input || typeof input !== 'object') throw new Error('无效的引擎设置')
    const defaults = normalizeHarnessDefaults(input)
    if ((input.model !== null && !defaults.model) || input.thinkingLevel !== defaults.thinkingLevel) {
      throw new Error('无效的默认模型或 Thinking 档位')
    }
    store.mutate((draft) => {
      if (defaults.model || defaults.thinkingLevel) draft.harnessDefaults[harness] = defaults
      else delete draft.harnessDefaults[harness]
    })
    return defaults
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

  ipcMain.handle('dialog:pickExecutable', async () => {
    const win = getWindow()
    const options: Electron.OpenDialogOptions = { title: '选择 CLI 可执行文件', properties: ['openFile'] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('projects:add', (_e, dirPath: string) => {
    const abs = resolve(dirPath.trim())
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`目录不存在: ${abs}`)
    }
    const state = store.snapshot()
    const existing = state.projects.find((p) => p.path.toLowerCase() === abs.toLowerCase())
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
      defaultHarness: state.activeHarness,
      trustPreset: state.defaultProjectTrust,
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

  ipcMain.handle('projects:setTrust', (_e, projectId: string, preset: string) => {
    if (!isTrustPreset(preset)) throw new Error(`无效的权限预设: ${preset}`)
    let updated: ProjectEntry | undefined
    store.mutate((draft) => {
      const target = draft.projects.find((p) => p.id === projectId)
      if (target) {
        target.trustPreset = preset
        updated = structuredClone(target)
      }
    })
    if (!updated) throw new Error('项目不存在')
    return updated
  })

  ipcMain.handle('threads:create', (_e, input: CreateThreadInput) => {
    const state = store.snapshot()
    const project = state.projects.find((p) => p.id === input.projectId)
    if (!project) throw new Error('所属项目不存在')
    const cwd = input.cwd ? resolve(input.cwd) : project.path
    if (!existsSync(cwd)) throw new Error(`工作目录不存在: ${cwd}`)
    const defaults = input.sessionPath ? undefined : state.harnessDefaults[input.harness]
    const hasModelOverride = input.modelId !== undefined || input.modelProvider !== undefined

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
      modelProvider: (hasModelOverride ? input.modelProvider : defaults?.model?.provider) ?? null,
      modelId: (hasModelOverride ? input.modelId : defaults?.model?.id) ?? null,
      thinkingLevel: input.thinkingLevel ?? defaults?.thinkingLevel ?? 'medium',
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
      if (patch.harness && patch.harness !== target.harness && !target.sessionPath && target.status === 'idle' && runtimeManager.getTimeline(threadId).length === 0) {
        target.harness = patch.harness
        const defaults = draft.harnessDefaults[patch.harness]
        target.modelProvider = defaults?.model?.provider ?? null
        target.modelId = defaults?.model?.id ?? null
        target.thinkingLevel = defaults?.thinkingLevel ?? 'medium'
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

  ipcMain.handle('threads:getTurnDiff', (_e, threadId: string, summaryId: string) => {
    return runtimeManager.getTurnDiff(threadId, summaryId)
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

  ipcMain.handle('workspace:listDir', (_e, cwd: string, relPath?: string) => {
    return workspaceBrowser.listDir(cwd, relPath ?? '')
  })

  ipcMain.handle('workspace:readFile', (_e, cwd: string, relPath: string) => {
    return workspaceBrowser.readFile(cwd, relPath)
  })

  ipcMain.handle('terminal:start', (_e, cwd: string, command: string) => {
    return terminal.start(cwd, command)
  })

  ipcMain.handle('terminal:stop', (_e, runId: string) => {
    return terminal.stop(runId)
  })

  ipcMain.handle('browser:status', (_e, refresh?: boolean) => browserCompanion.getStatus(refresh === true))
  ipcMain.handle('browser:spaces', () => browserCompanion.listSpaces())
  ipcMain.handle('browser:tabs', () => browserCompanion.listTabs())
  ipcMain.handle('browser:open', (_e, url: string) => browserCompanion.openUrl(url))
  ipcMain.handle('browser:activateTab', (_e, label: string) => browserCompanion.activateTab(label))
  ipcMain.handle('browser:screenshot', () => browserCompanion.screenshot())

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

  // ── 设置：MCP / 插件 / 技能 / 使用情况 ─────────────────────────────────
  const validProjectPath = (projectPath?: string | null): string | null => {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return null
    const abs = resolve(projectPath.trim())
    return existsSync(abs) && statSync(abs).isDirectory() ? abs : null
  }
  const asEngine = (engine: unknown): ExtensionEngine => {
    if (!isExtensionEngine(engine)) throw new Error('无效的引擎（仅支持 Pi / OMP / Prime）')
    return engine
  }

  ipcMain.handle('ext:getMcp', (_e, engine: unknown, projectPath?: string | null) => engineMcp.getSnapshot(asEngine(engine), validProjectPath(projectPath)))
  ipcMain.handle('ext:mcpAdd', async (_e, input: McpAddInput, projectPath?: string | null) => {
    if (!input || typeof input !== 'object') throw new Error('无效的添加请求')
    const engine = asEngine(input.engine)
    const snapshot = await engineMcp.addServer(input, validProjectPath(projectPath))
    return snapshot
  })
  ipcMain.handle('ext:mcpRemove', (_e, engine: unknown, scope: string, name: string, projectPath?: string | null) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('无效的作用范围')
    return engineMcp.removeServer(asEngine(engine), scope, String(name), validProjectPath(projectPath))
  })
  ipcMain.handle('ext:mcpCheckLive', (_e, engine: unknown, projectPath?: string | null) => engineMcp.getSnapshot(asEngine(engine), validProjectPath(projectPath), true))

  ipcMain.handle('ext:getPackages', (_e, engine: unknown, projectPath?: string | null) => enginePackages.getSnapshot(asEngine(engine), validProjectPath(projectPath)))
  ipcMain.handle('ext:packageInstall', (_e, engine: unknown, source: string, scope: string, projectPath?: string | null) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('无效的作用范围')
    return enginePackages.install(asEngine(engine), String(source), scope, validProjectPath(projectPath))
  })
  ipcMain.handle('ext:packageRemove', (_e, engine: unknown, name: string, scope: string, projectPath?: string | null) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('无效的作用范围')
    return enginePackages.remove(asEngine(engine), String(name), scope, validProjectPath(projectPath))
  })
  ipcMain.handle('ext:packageUpdate', (_e, engine: unknown, name: string | null, scope: string, projectPath?: string | null) => {
    if (scope !== 'user' && scope !== 'project') throw new Error('无效的作用范围')
    return enginePackages.update(asEngine(engine), name === null ? null : String(name), scope, validProjectPath(projectPath))
  })

  ipcMain.handle('ext:getSkills', (_e, engine: unknown, projectPath?: string | null) => engineSkills.getSnapshot(asEngine(engine), validProjectPath(projectPath)))
  ipcMain.handle('ext:readSkill', (_e, filePath: string) => engineSkills.readSkillFile(String(filePath)))

  ipcMain.handle('usage:getReport', (_e, filters?: UsageFilters, refresh?: boolean) => {
    if (filters !== undefined && (filters === null || typeof filters !== 'object' || Array.isArray(filters))) {
      throw new Error('无效的筛选条件')
    }
    return usage.getReport(filters ?? {}, refresh === true)
  })

  // 独立浏览器窗口的 browserWin:* 路由由 BrowserWindowService.register() 自行注册。
  void browserWindow
}
