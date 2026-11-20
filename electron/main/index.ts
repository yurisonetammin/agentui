import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { HarnessDiscoveryService } from './discovery'
import { BrowserCompanionService } from './browser-companion'
import { GitService } from './git/git-service'
import { registerIpcHandlers } from './ipc'
import { ModelCatalogService } from './model-catalog'
import { RuntimeManager } from './rpc/manager'
import { StateStore } from './store'
import { TerminalService } from './terminal-service'
import { WorkspaceBrowserService } from './workspace-browser'
import { WorkspaceFileService } from './workspace-files'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

if (process.platform === 'win32') {
  app.setAppUserModelId('com.agentui.desktop')
}

function resolveAppIcon(): Electron.NativeImage | string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          join(__dirname, '../../assets/icon.ico'),
          join(app.getAppPath(), 'assets/icon.ico'),
          join(__dirname, '../../assets/icon.png'),
          join(app.getAppPath(), 'assets/icon.png'),
        ]
      : [
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
})

function createMainWindow(): void {
  const rendererFilePath = join(__dirname, '../renderer/index.html')
  const rendererFileUrl = pathToFileURL(rendererFilePath).href

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1020,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'AgentUI — 多引擎编码 Agent 工作台',
    icon: resolveAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

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
    mainWindow = null
  })
}

void app.whenReady().then(async () => {
  registerIpcHandlers({
    getWindow: () => mainWindow,
    store,
    discovery,
    models,
    git,
    workspaceFiles,
    workspaceBrowser,
    browserCompanion,
    terminal,
    runtimeManager,
  })
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
  void Promise.allSettled([runtimeManager.stopAll(), terminal.stopAll()]).finally(() => {
    app.exit(0)
  })
})
