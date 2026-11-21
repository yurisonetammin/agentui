import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  app,
  session as electronSession,
  ipcMain,
  nativeTheme,
  BrowserWindow,
  WebContentsView,
  type Session,
  type WebContentsView as WebContentsViewType,
} from 'electron'
import type { BrowserWinTabInfo, ShareToThreadInput } from '@shared/types'

const BROWSER_PARTITION = 'persist:agentui-browser'
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const DEFAULT_URL = 'about:blank'

interface BrowserTab {
  id: string
  view: WebContentsViewType
  favicon?: string
}

function isAllowedUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'about:' && parsed.pathname === 'blank') return parsed
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname ? parsed : null
    return null
  } catch {
    return null
  }
}

/**
 * 独立浏览器窗口：AgentUI 自己的多标签设计。
 * - 每个标签一个 WebContentsView，运行在独立 `persist:agentui-browser` 会话中，
 *   登录状态与工作台窗口完全隔离。
 * - 权限请求（摄像头/通知等）默认拒绝；弹窗转成新标签。
 * - 支持把当前页链接 / 选中文本 / 截图 发送到指定会话的输入框。
 */
export class BrowserWindowService {
  private win: BrowserWindow | null = null
  private tabs: BrowserTab[] = []
  private activeTabId: string | null = null
  private insetTop = 0
  private pushTimer: NodeJS.Timeout | null = null
  private isolatedSession: Session | null = null

  constructor(
    private readonly deps: {
      getMainWindow: () => BrowserWindow | null
      resolveRendererFile: (name: string) => string
      /** 校验目标会话是否存在。 */
      threadExists: (threadId: string) => boolean
    },
  ) {}

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  show(): void {
    if (this.isOpen() && this.win) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.focus()
      return
    }
    this.createWindow()
  }

  private ensureSession(): Session {
    if (this.isolatedSession) return this.isolatedSession
    const ses = electronSession.fromPartition(BROWSER_PARTITION)
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    this.isolatedSession = ses
    return ses
  }

  private createWindow(): void {
    const rendererFilePath = this.deps.resolveRendererFile('browser.html')
    const rendererFileUrl = new URL(`file://${rendererFilePath.replace(/\\/g, '/')}`).href
    const ses = this.ensureSession()

    const win = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191b' : '#faf9f7',
      title: 'AgentUI 浏览器',
      titleBarStyle: 'hidden',
      titleBarOverlay: process.platform === 'darwin'
        ? true
        : {
            color: '#00000000',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#e9e9e7' : '#252726',
            height: 42,
          },
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: ses,
      },
    })
    this.win = win

    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.win = null
      this.activeTabId = null
      for (const tab of this.tabs) {
        try { tab.view.webContents.close() } catch { /* ignore */ }
      }
      this.tabs = []
    })

    // 防止浏览器窗口的 UI 页面被导航到任意外部地址
    win.webContents.on('will-navigate', (event, url) => {
      const devOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : null
      let allowed = false
      try {
        const parsed = new URL(url)
        allowed = devOrigin ? parsed.origin === devOrigin && parsed.pathname === '/browser.html' : parsed.href === rendererFileUrl
      } catch {
        allowed = false
      }
      if (!allowed) event.preventDefault()
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/browser.html`)
    } else if (existsSync(rendererFilePath)) {
      void win.loadFile(rendererFilePath)
    } else {
      void win.loadURL(rendererFileUrl)
    }

    // 首个空标签
    this.createTab(DEFAULT_URL)
  }

  // ── 标签管理 ─────────────────────────────────────────────────────────

  private activeTab(): BrowserTab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? this.tabs[0] ?? null
  }

  private requireWindow(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) throw new Error('浏览器窗口未打开')
    return this.win
  }

  private attachViewHandlers(tab: BrowserTab): void {
    const { webContents } = tab.view
    const notify = () => this.pushTabs()

    webContents.on('page-title-updated', notify)
    webContents.on('page-favicon-updated', (_e, favicons) => {
      const icon = favicons?.[favicons.length - 1]
      if (typeof icon === 'string') tab.favicon = icon
      notify()
    })
    webContents.on('did-start-loading', notify)
    webContents.on('did-stop-loading', notify)
    webContents.on('did-navigate', (_e, url) => {
      if (url.startsWith('file://')) {
        // 阻断渲染进程被导到本地文件
        webContents.loadURL(DEFAULT_URL).catch(() => undefined)
        return
      }
      notify()
    })
    webContents.on('did-navigate-in-page', notify)
    webContents.on('render-process-gone', notify)
    webContents.setWindowOpenHandler(({ url }) => {
      const parsed = isAllowedUrl(url)
      if (parsed) {
        this.createTab(parsed.href)
      } else {
        this.pushTabs()
      }
      return { action: 'deny' }
    })
  }

  private layout(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const { width, height } = win.getContentBounds()
    for (const tab of this.tabs) {
      tab.view.setBounds({ x: 0, y: this.insetTop, width, height: Math.max(0, height - this.insetTop) })
      tab.view.setVisible(tab.id === this.activeTabId)
    }
  }

  createTab(url?: string): BrowserWinTabInfo[] {
    const win = this.requireWindow()
    const target = url ? isAllowedUrl(url) : isAllowedUrl(DEFAULT_URL)
    if (!target) throw new Error('仅支持 http(s) 地址')

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: this.ensureSession(),
      },
    })
    const tab: BrowserTab = { id: randomUUID(), view }
    this.tabs.push(tab)
    win.contentView.addChildView(view)
    this.attachViewHandlers(tab)
    this.activateTab(tab.id)
    void view.webContents.loadURL(target.href).catch(() => undefined)
    this.layout()
    return this.tabInfos()
  }

  closeTab(tabId: string): BrowserWinTabInfo[] {
    const win = this.requireWindow()
    const index = this.tabs.findIndex((t) => t.id === tabId)
    if (index === -1) throw new Error('标签不存在')
    const [tab] = this.tabs.splice(index, 1)
    win.contentView.removeChildView(tab.view)
    try { tab.view.webContents.close() } catch { /* ignore */ }
    if (this.tabs.length === 0) {
      // 关闭最后一个标签时保留一个空标签，窗口保持可用
      this.createTab(DEFAULT_URL)
    } else if (this.activeTabId === tabId) {
      this.activeTabId = null
      this.activateTab(this.tabs[Math.max(0, index - 1)]!.id)
    } else {
      this.layout()
      this.pushTabs()
    }
    return this.tabInfos()
  }

  activateTab(tabId: string): BrowserWinTabInfo[] {
    this.requireWindow()
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error('标签不存在')
    this.activeTabId = tabId
    this.layout()
    if (this.win?.isFocused()) tab.view.webContents.focus()
    this.pushTabs()
    return this.tabInfos()
  }

  navigate(url: string): BrowserWinTabInfo[] {
    const tab = this.activeTab()
    if (!tab) return this.createTab(url)
    const target = isAllowedUrl(url)
    if (!target) throw new Error('仅支持 http(s) 地址')
    void tab.view.webContents.loadURL(target.href).catch(() => undefined)
    this.pushTabs()
    return this.tabInfos()
  }

  goBack(): BrowserWinTabInfo[] {
    const tab = this.activeTab()
    if (tab?.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack()
    return this.tabInfos()
  }

  goForward(): BrowserWinTabInfo[] {
    const tab = this.activeTab()
    if (tab?.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward()
    return this.tabInfos()
  }

  reload(): BrowserWinTabInfo[] {
    const tab = this.activeTab()
    if (tab) tab.view.webContents.reload()
    return this.tabInfos()
  }

  stop(): BrowserWinTabInfo[] {
    const tab = this.activeTab()
    if (tab) tab.view.webContents.stop()
    return this.tabInfos()
  }

  setInsets(top: number): void {
    const value = Math.max(0, Math.min(400, Math.round(top)))
    if (value === this.insetTop) return
    this.insetTop = value
    this.layout()
  }

  tabInfos(): BrowserWinTabInfo[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.view.webContents.getTitle() || '新标签页',
      url: tab.view.webContents.getURL() || '',
      isLoading: tab.view.webContents.isLoading(),
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
      active: tab.id === this.activeTabId,
      favicon: tab.favicon,
    }))
  }

  private pushTabs(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('agentui:browserWinTabs', this.tabInfos())
      }
    }, 80)
    this.pushTimer.unref?.()
  }

  // ── 分享到会话 ─────────────────────────────────────────────────────────

  async share(input: { threadId: string; kind: ShareToThreadInput['kind'] }): Promise<void> {
    if (!this.deps.threadExists(input.threadId)) throw new Error('目标会话不存在')
    const tab = this.activeTab()
    let payload: ShareToThreadInput
    if (input.kind === 'link') {
      if (!tab) throw new Error('没有可分享的标签页')
      const url = tab.view.webContents.getURL()
      if (!url || !/^https?:/i.test(url)) throw new Error('当前页面不是 http(s) 地址')
      payload = { kind: 'link', url, title: tab.view.webContents.getTitle() || url, fromUrl: url }
    } else if (input.kind === 'text') {
      if (!tab) throw new Error('没有可分享的标签页')
      const selection = await tab.view.webContents.executeJavaScript(
        'typeof window.getSelection === "function" ? String(window.getSelection()) : ""',
        true,
      )
      const text = (selection ?? '').trim()
      if (!text) throw new Error('当前页面没有选中文本')
      payload = { kind: 'text', text: text.slice(0, 20_000), fromUrl: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() }
    } else {
      if (!tab) throw new Error('没有可分享的标签页')
      const image = await tab.view.webContents.capturePage()
      const png = image.toPNG()
      if (png.byteLength > MAX_IMAGE_BYTES) throw new Error('截图超过 10MB 限制')
      payload = {
        kind: 'image',
        imageData: png.toString('base64'),
        mimeType: 'image/png',
        fromUrl: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle(),
      }
    }
    const target = this.deps.getMainWindow()
    if (!target || target.isDestroyed()) throw new Error('工作台窗口未打开，无法分享')
    target.webContents.send('agentui:shareToComposer', { threadId: input.threadId, ...payload })
  }

  /** 注册本服务的 IPC 路由（app ready 后调用一次）。 */
  register(): void {
    const guard = <T>(fn: () => T): T => {
      if (!this.win || this.win.isDestroyed()) throw new Error('浏览器窗口未打开')
      return fn()
    }
    ipcMain.handle('browserWin:show', () => {
      this.show()
      return this.isOpen()
    })
    ipcMain.handle('browserWin:isOpen', () => this.isOpen())
    ipcMain.handle('browserWin:createTab', (_e, url?: string) => guard(() => this.createTab(typeof url === 'string' ? url : undefined)))
    ipcMain.handle('browserWin:closeTab', (_e, tabId: string) => guard(() => this.closeTab(String(tabId))))
    ipcMain.handle('browserWin:activateTab', (_e, tabId: string) => guard(() => this.activateTab(String(tabId))))
    ipcMain.handle('browserWin:navigate', (_e, url: string) => guard(() => this.navigate(String(url))))
    ipcMain.handle('browserWin:back', () => guard(() => this.goBack()))
    ipcMain.handle('browserWin:forward', () => guard(() => this.goForward()))
    ipcMain.handle('browserWin:reload', () => guard(() => this.reload()))
    ipcMain.handle('browserWin:stop', () => guard(() => this.stop()))
    ipcMain.handle('browserWin:setInsets', (_e, top: number) => {
      if (typeof top === 'number' && Number.isFinite(top)) this.setInsets(top)
    })
    ipcMain.handle('browserWin:share', async (_e, target: { threadId: string; kind: ShareToThreadInput['kind'] }) => {
      if (!target || typeof target.threadId !== 'string' || !['link', 'text', 'image'].includes(target.kind)) {
        throw new Error('无效的分享请求')
      }
      await this.share(target)
    })

    app.on('before-quit', () => {
      for (const tab of this.tabs) {
        try { tab.view.webContents.close() } catch { /* ignore */ }
      }
      this.tabs = []
    })
  }
}
