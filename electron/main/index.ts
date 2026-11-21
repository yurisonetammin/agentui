import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeImage, nativeTheme, shell } from 'electron'
import { HarnessDiscoveryService } from './discovery'
import { BrowserCompanionService } from './browser-companion'
import { BrowserWindowService } from './browser-window-service'
import { HerdrService } from './herdr-service'
import { EngineMcpService } from './extensions/mcp-service'
import { EnginePackageService } from './extensions/package-service'
import { EngineSkillService } from './extensions/skill-service'
import { GitService } from './git/git-service'
import { registerIpcHandlers } from './ipc'
import { ModelCatalogService } from './model-catalog'
import { RuntimeManager } from './rpc/manager'
import { SessionSearchService } from './sessions/search-index'
import { StateStore } from './store'
import { TerminalService } from './terminal-service'
import { UsageService } from './usage-service'
import { WorkspaceBrowserService } from './workspace-browser'
import { WorkspaceFileService } from './workspace-files'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

if (process.platform === 'win32') {
  app.setAppUserModelId('com.agentui.desktop')
}

function resolveAppIcon(): Electron.NativeImage | string | undefined {
  const resDir = process.resourcesPath ? join(process.resourcesPath, 'assets') : null
  const candidates =
    process.platform === 'win32'
      ? [
          ...(resDir ? [join(resDir, 'icon.ico'), join(resDir, 'icon.png')] : []),
          join(__dirname, '../../assets/icon.ico'),
          join(app.getAppPath(), 'assets/icon.ico'),
          join(__dirname, '../../assets/icon.png'),
          join(app.getAppPath(), 'assets/icon.png'),
        ]
      : [
          ...(resDir ? [join(resDir, 'icon.png')] : []),
          join(__dirname, '../../assets/icon.png'),
          join(app.getAppPath(), 'assets/icon.png'),
        ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (candidate.endsWith('.ico')) return candidate
    const img = nativeImage.createFromPath(candidate)
    if (!img.isEmpty()) return img
    return candidate
  }
  return undefined
}

const store = new StateStore(process.env.AGENTUI_STATE_PATH || undefined)
const discovery = new HarnessDiscoveryService()
const models = new ModelCatalogService(discovery)
const git = new GitService()
const workspaceFiles = new WorkspaceFileService()
const workspaceBrowser = new WorkspaceBrowserService()
const browserCompanion = new BrowserCompanionService(() => store.snapshot().projects.map((p) => p.path))

function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

const terminal = new TerminalService({
  onOutput: (event) => sendToWindow('agentui:terminalOutput', event),
  onExit: (event) => sendToWindow('agentui:terminalExit', event),
})

const herdr = new HerdrService({
  onFrame: (event) => sendToWindow('agentui:herdrFrame', event),
  onStreamClosed: (event) => sendToWindow('agentui:herdrStreamClosed', event),
  onConnectionChanged: (id) => sendToWindow('agentui:herdrConnectionChanged', id),
}, {
  getSettings: () => store.snapshot().herdr,
  setSettings: (next) => {
    store.mutate((draft) => {
      draft.herdr = next
    })
  },
})

const runtimeManager = new RuntimeManager(store, discovery, {
  onThreadEvent: (envelope) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agentui:threadEvent', envelope)
    }
  },
  onThreadStatus: (update) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agentui:threadStatus', update)
    }
  },
  onExtensionUiRequest: (req) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agentui:extensionUiRequest', req)
    }
  },
}, git)

const browserWindowService = new BrowserWindowService({
  getMainWindow: () => mainWindow,
  resolveRendererFile: (name) => join(__dirname, '../renderer', name),
  threadExists: (threadId) => store.snapshot().threads.some((t) => t.id === threadId),
})
const engineMcp = new EngineMcpService({
  discovery,
  getSessionState: (engine, projectPath) => runtimeManager.getEngineSessionState(engine, projectPath),
})
const enginePackages = new EnginePackageService(discovery)
const engineSkills = new EngineSkillService(discovery)
const usage = new UsageService(store, discovery, runtimeManager)
const sessionSearch = new SessionSearchService({
  store,
  discovery,
  getCachedTimeline: (threadId) => runtimeManager.getCachedTimeline(threadId),
})

function createMainWindow(): void {
  const rendererFilePath = join(__dirname, '../renderer/index.html')
  const rendererFileUrl = pathToFileURL(rendererFilePath).href

  const overlay = () => ({
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#e9e9e7' : '#252726',
    height: 46,
  })
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1020,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191b' : '#faf9f7',
    title: 'AgentUI — 多引擎编码 Agent 工作台',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : overlay(),
    autoHideMenuBar: true,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = win
  const onThemeUpdate = () => {
    if (process.platform !== 'darwin' && !win.isDestroyed()) win.setTitleBarOverlay(overlay())
  }
  nativeTheme.on('updated', onThemeUpdate)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devOrigin = process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin
      : null
    let isAllowed = false
    try {
      const parsed = new URL(url)
      if (devOrigin) {
        isAllowed = parsed.origin === devOrigin
      } else {
        isAllowed = parsed.href === rendererFileUrl || parsed.href.startsWith(`${rendererFileUrl}#`)
      }
    } catch {
      isAllowed = false
    }
    if (!isAllowed) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(rendererFilePath)
  }

  mainWindow.on('closed', () => {
    nativeTheme.removeListener('updated', onThemeUpdate)
    mainWindow = null
  })
}

void app.whenReady().then(async () => {
  nativeTheme.themeSource = store.snapshot().appearance.theme
  registerIpcHandlers({
    getWindow: () => mainWindow,
    store,
    discovery,
    models,
    git,
    workspaceFiles,
    workspaceBrowser,
    browserCompanion,
    browserWindow: browserWindowService,
    engineMcp,
    enginePackages,
    engineSkills,
    usage,
    terminal,
    herdr,
    runtimeManager,
    sessionSearch,
  })
  browserWindowService.register()
  await discovery.refresh(store.snapshot().customBinaryPaths).catch(() => undefined)
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  sessionSearch.flushToDisk()
  void Promise.allSettled([runtimeManager.stopAll(), terminal.stopAll(), herdr.stopStreams()]).finally(() => {
    app.exit(0)
  })
})
