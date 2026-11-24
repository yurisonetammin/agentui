import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Image as ImageIcon,
  Link2,
  Loader2,
  Plus,
  RotateCw,
  Send,
  Share2,
  Text,
  X,
} from 'lucide-react'
import type { BrowserPickedElement } from '@shared/browser-annotation'
import type { BrowserWinTabInfo, SharePayloadKind, ThreadEntry } from '@shared/types'
import { normalizeUrlInput } from '@shared/browser-url'
import { errorText } from '../src/components/SettingsControls'

const SHARE_MODES: Array<{ kind: Exclude<SharePayloadKind, 'annotation'>; label: string; icon: typeof Link2 }> = [
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
  const [shareMode, setShareMode] = useState<Exclude<SharePayloadKind, 'annotation'> | null>(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareDone, setShareDone] = useState<string | null>(null)

  const [picking, setPicking] = useState(false)
  const [pickedElement, setPickedElement] = useState<BrowserPickedElement | null>(null)
  const [annotationNote, setAnnotationNote] = useState('')
  const [targetThreadId, setTargetThreadId] = useState('')

  const toolbarRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const activeTab = useMemo(() => tabs.find((t) => t.active) ?? null, [tabs])
  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20),
    [threads],
  )

  const refreshThreads = useCallback(async () => {
    try {
      const state = await window.agentui.getState()
      setThreads(state.threads)
      setTargetThreadId((prev) => {
        if (prev && state.threads.some((t) => t.id === prev)) return prev
        return state.activeThreadId ?? state.threads[0]?.id ?? ''
      })
    } catch {
      /* ignore */
    }
  }, [])

  const refreshTabs = useCallback((next: BrowserWinTabInfo[]) => {
    setTabs(next)
    const active = next.find((t) => t.active)
    setUrlValue(active?.url ?? '')
  }, [])

  useEffect(() => {
    const unsub = window.agentui.onBrowserWinTabs(refreshTabs)
    void refreshThreads()
    return unsub
  }, [refreshTabs, refreshThreads])

  // 把工具栏高度上报给主进程，WebContentsView 挂载在其下方（避免任何浮层被原生视图遮挡）
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
    setPickedElement(null)
    void run(() => window.agentui.browserWinNavigate(target))
  }

  async function toggleElementPick() {
    setError(null)
    setShareDone(null)
    if (picking) {
      setPicking(false)
      await window.agentui.browserWinCancelPick().catch(() => undefined)
      return
    }
    setShareOpen(false)
    setPickedElement(null)
    setPicking(true)
    void refreshThreads()
    try {
      const result = await window.agentui.browserWinStartPick()
      if (result) {
        setPickedElement(result)
        setAnnotationNote('')
        requestAnimationFrame(() => noteRef.current?.focus())
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPicking(false)
    }
  }

  async function sendAnnotation() {
    if (!pickedElement || !targetThreadId || shareBusy) return
    setShareBusy(true)
    setError(null)
    setShareDone(null)
    try {
      await window.agentui.browserWinShareAnnotation({
        threadId: targetThreadId,
        element: pickedElement,
        note: annotationNote,
      })
      const target = threads.find((t) => t.id === targetThreadId)
      setShareDone(target ? `已将元素批注发送到「${target.title}」，回工作台确认后发送` : '已发送批注')
      setPickedElement(null)
      setAnnotationNote('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setShareBusy(false)
    }
  }

  async function share(threadId: string, mode: Exclude<SharePayloadKind, 'annotation'>) {
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
          <button
            type="button"
            className={`btn-small${picking ? ' is-picking' : ''}`}
            aria-pressed={picking}
            title="点选页面 DOM 元素并附加局部截图与批注发送到会话"
            onClick={() => void toggleElementPick()}
          >
            <Crosshair size={13} />
            {picking ? '点选中（取消）' : '点选批注'}
          </button>
          <button
            type="button"
            className="btn-small"
            title="把链接 / 选中文本 / 截图发送到会话"
            aria-expanded={shareOpen}
            onClick={() => {
              const next = !shareOpen
              setShareOpen(next)
              if (next) {
                setPickedElement(null)
                void refreshThreads()
              } else {
                setShareMode(null)
              }
            }}
          >
            <Share2 size={13} /> 分享到会话
          </button>
        </div>

        {picking && (
          <div className="browser-status is-info" role="status">
            移动鼠标高亮目标网页元素，点击即可抓取选择器与局部截图（按 Esc 或再次点击「点选中」取消）。
          </div>
        )}

        {pickedElement && (
          <div className="browser-annotation-panel">
            <div className="browser-annotation-head">
              <div className="browser-annotation-meta">
                <span className="browser-annotation-tag">&lt;{pickedElement.tag}&gt;</span>
                <code className="browser-annotation-selector" title={pickedElement.selector}>
                  {pickedElement.selector}
                </code>
                <span className="browser-annotation-dims">
                  {pickedElement.rect.width}×{pickedElement.rect.height}
                </span>
              </div>
              <div className="browser-annotation-head-actions">
                <button type="button" className="btn-small" onClick={() => void toggleElementPick()}>
                  <Crosshair size={12} /> 重选
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭批注面板"
                  onClick={() => setPickedElement(null)}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
            <div className="browser-annotation-body">
              {pickedElement.imageData && (
                <img
                  className="browser-annotation-thumb"
                  src={`data:${pickedElement.mimeType ?? 'image/png'};base64,${pickedElement.imageData}`}
                  alt="所选元素局部截图"
                />
              )}
              <div className="browser-annotation-form">
                {pickedElement.text && (
                  <p className="browser-annotation-excerpt" title={pickedElement.text}>
                    文本：{pickedElement.text}
                  </p>
                )}
                <textarea
                  ref={noteRef}
                  className="text-input browser-annotation-note"
                  rows={2}
                  placeholder="输入修改建议或问题描述（Ctrl+Enter 发送到会话草稿）…"
                  value={annotationNote}
                  onChange={(e) => setAnnotationNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      void sendAnnotation()
                    }
                  }}
                />
                <div className="browser-annotation-footer">
                  <select
                    className="text-input browser-annotation-thread"
                    aria-label="目标会话"
                    value={targetThreadId}
                    onChange={(e) => setTargetThreadId(e.target.value)}
                  >
                    {sortedThreads.length === 0 && <option value="">工作台暂无会话</option>}
                    {sortedThreads.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={shareBusy || !targetThreadId}
                    onClick={() => void sendAnnotation()}
                  >
                    <Send size={12} />
                    {shareBusy ? '发送中…' : '发送批注到会话'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {shareOpen && (
          <div className="browser-share-drawer">
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
              <button type="button" className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="关闭分享"
                onClick={() => { setShareOpen(false); setShareMode(null) }}>
                <X size={13} />
              </button>
            </div>
            <p className="browser-share-hint">先选分享内容类型，再选目标会话；内容会填入该会话的输入框，由你确认后发送。</p>
            <div className="browser-share-threads">
              {sortedThreads.length === 0 && <p className="browser-share-empty">工作台还没有会话。</p>}
              {sortedThreads.slice(0, 8).map((thread) => (
                <button key={thread.id} type="button" disabled={shareBusy || !shareMode}
                  onClick={() => void share(thread.id, shareMode!)}>
                  <span>{thread.title}</span>
                  <small>{new Date(thread.updatedAt).toLocaleString()}</small>
                </button>
              ))}
            </div>
          </div>
        )}

        {shareDone && <div className="browser-status is-success" role="status">{shareDone}</div>}
        {error && <div className="browser-status is-error" role="alert">{error}</div>}
      </div>
    </div>
  )
}
