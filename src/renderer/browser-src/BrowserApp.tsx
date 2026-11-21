import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Image as ImageIcon,
  Link2,
  Loader2,
  Plus,
  RotateCw,
  Share2,
  Text,
  X,
} from 'lucide-react'
import type { BrowserWinTabInfo, SharePayloadKind, ThreadEntry } from '@shared/types'
import { normalizeUrlInput } from '@shared/browser-url'
import { errorText } from '../src/components/SettingsControls'

const SHARE_MODES: Array<{ kind: SharePayloadKind; label: string; icon: typeof Link2 }> = [
  { kind: 'link', label: '链接', icon: Link2 },
  { kind: 'text', label: '选中文本', icon: Text },
  { kind: 'image', label: '截图', icon: ImageIcon },
]

export function BrowserApp() {
  const [tabs, setTabs] = useState<BrowserWinTabInfo[]>([])
  const [urlValue, setUrlValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadEntry[]>([])
  const [shareOpen, setShareOpen] = useState(false)
  const [shareMode, setShareMode] = useState<SharePayloadKind | null>(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareDone, setShareDone] = useState<string | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const activeTab = useMemo(() => tabs.find((t) => t.active) ?? null, [tabs])

  const refreshTabs = useCallback((next: BrowserWinTabInfo[]) => {
    setTabs(next)
    const active = next.find((t) => t.active)
    setUrlValue(active?.url ?? '')
  }, [])

  useEffect(() => {
    const unsub = window.agentui.onBrowserWinTabs(refreshTabs)
    void window.agentui.getState().then((state) => setThreads(state.threads)).catch(() => undefined)
    return unsub
  }, [refreshTabs])

  // 把工具栏高度上报给主进程，WebContentsView 挂载在其下方
  useEffect(() => {
    const element = toolbarRef.current
    if (!element) return
    const report = () => {
      const bottom = element.getBoundingClientRect().bottom
      if (Number.isFinite(bottom)) void window.agentui.browserWinSetInsets(Math.round(bottom))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  async function run(action: () => Promise<BrowserWinTabInfo[] | void>) {
    setError(null)
    try {
      const next = await action()
      if (Array.isArray(next)) refreshTabs(next)
    } catch (err) {
      setError(errorText(err))
    }
  }

  // Ctrl+T / Ctrl+W 管理标签页
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey) return
      if (event.key === 't') {
        event.preventDefault()
        void run(() => window.agentui.browserWinCreateTab())
      } else if (event.key === 'w' && activeTab) {
        event.preventDefault()
        void run(() => window.agentui.browserWinCloseTab(activeTab.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab?.id])

  function navigate(value: string) {
    const target = normalizeUrlInput(value)
    if (!target) return
    setUrlValue(target)
    void run(() => window.agentui.browserWinNavigate(target))
  }

  async function share(threadId: string, mode: SharePayloadKind) {
    setShareBusy(true)
    setError(null)
    setShareDone(null)
    try {
      await window.agentui.browserWinShare({ threadId, kind: mode })
      const target = threads.find((t) => t.id === threadId)
      setShareDone(target ? `已发送到「${target.title}」，回工作台确认后发送` : '已发送')
      setShareMode(null)
      setShareOpen(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setShareBusy(false)
    }
  }

  return (
    <div className="browser-shell">
      <div ref={toolbarRef} className="browser-toolbar">
        <div className="browser-tabstrip">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`browser-tab${tab.active ? ' active' : ''}`}
              title={tab.url}
              onClick={() => void run(() => window.agentui.browserWinActivateTab(tab.id))}
              onAuxClick={(event) => {
                if (event.button === 1) void run(() => window.agentui.browserWinCloseTab(tab.id))
              }}
            >
              {tab.favicon && <img src={tab.favicon} alt="" className="browser-tab-favicon" />}
              <span className="browser-tab-title">{tab.title}</span>
              {tab.isLoading && <Loader2 size={12} className="spin" />}
              <span
                className="browser-tab-close"
                role="button"
                aria-label="关闭标签页"
                onClick={(event) => {
                  event.stopPropagation()
                  void run(() => window.agentui.browserWinCloseTab(tab.id))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.stopPropagation()
                    void run(() => window.agentui.browserWinCloseTab(tab.id))
                  }
                }}
                tabIndex={0}
              >
                <X size={11} />
              </span>
            </button>
          ))}
          <button type="button" className="icon-btn" title="新建标签页 (Ctrl+T)" aria-label="新建标签页"
            onClick={() => void run(() => window.agentui.browserWinCreateTab())}>
            <Plus size={14} />
          </button>
        </div>
        <div className="browser-nav">
          <button type="button" className="icon-btn" title="后退" aria-label="后退" disabled={!activeTab?.canGoBack}
            onClick={() => void run(() => window.agentui.browserWinGoBack())}><ArrowLeft size={15} /></button>
          <button type="button" className="icon-btn" title="前进" aria-label="前进" disabled={!activeTab?.canGoForward}
            onClick={() => void run(() => window.agentui.browserWinGoForward())}><ArrowRight size={15} /></button>
          {activeTab?.isLoading
            ? <button type="button" className="icon-btn" title="停止加载" aria-label="停止加载"
                onClick={() => void run(() => window.agentui.browserWinStop())}><X size={15} /></button>
            : <button type="button" className="icon-btn" title="重新加载" aria-label="重新加载"
                onClick={() => void run(() => window.agentui.browserWinReload())}><RotateCw size={14} /></button>}
          <form className="browser-address" onSubmit={(event) => {
            event.preventDefault()
            navigate(urlValue)
          }}>
            <input
              className="browser-url-input"
              value={urlValue}
              placeholder="输入网址，回车打开"
              aria-label="地址栏"
              spellCheck={false}
              onChange={(event) => setUrlValue(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </form>
          <div className="browser-share">
            <button type="button" className="btn-small" title="把链接 / 选中文本 / 截图发送到会话"
              aria-expanded={shareOpen}
              onClick={() => { setShareOpen((open) => !open); if (shareOpen) setShareMode(null) }}>
              <Share2 size={13} /> 分享到会话
            </button>
            {shareOpen && (
              <div className="browser-share-panel floating-card">
                <div className="browser-share-modes">
                  {SHARE_MODES.map(({ kind, label, icon: Icon }) => (
                    <button key={kind} type="button" className="btn-small"
                      aria-pressed={shareMode === kind}
                      disabled={shareBusy}
                      onClick={() => setShareMode(kind)}>
                      <Icon size={12} />
                      {label}
                    </button>
                  ))}
                </div>
                <p className="browser-share-hint">先选分享内容类型，再选目标会话；内容会填入该会话的输入框，由你确认后发送。</p>
                <div className="browser-share-threads">
                  {threads.length === 0 && <p className="browser-share-empty">工作台还没有会话。</p>}
                  {[...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12).map((thread) => (
                    <button key={thread.id} type="button" disabled={shareBusy || !shareMode}
                      onClick={() => void share(thread.id, shareMode!)}>
                      <span>{thread.title}</span>
                      <small>{new Date(thread.updatedAt).toLocaleString()}</small>
                    </button>
                  ))}
                </div>
                {shareDone && <p className="browser-share-done">{shareDone}</p>}
              </div>
            )}
          </div>
        </div>
        {error && <div className="browser-status is-error" role="alert">{error}</div>}
      </div>
    </div>
  )
}
