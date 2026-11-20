import { useEffect, useState } from 'react'
import { Camera, ExternalLink, Globe, RefreshCw, X } from 'lucide-react'
import type { BrowserStatus, BrowserTabInfo } from '@shared/types'

export function BrowserPanel({
  onClose,
  onScreenshot,
  screenshotBusy,
}: {
  onClose: () => void
  onScreenshot: () => void
  screenshotBusy: boolean
}) {
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'status' | 'open' | 'tabs' | null>('status')
  const [error, setError] = useState<string | null>(null)
  const [openedInfo, setOpenedInfo] = useState<string | null>(null)

  async function refreshStatus(refresh = false) {
    setBusy('status')
    setError(null)
    try {
      setStatus(await window.agentui.browserStatus(refresh))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function refreshTabs() {
    setBusy('tabs')
    setError(null)
    try {
      setTabs(await window.agentui.browserTabs())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function openUrl() {
    const trimmed = url.trim()
    if (!trimmed) return
    setBusy('open')
    setError(null)
    setOpenedInfo(null)
    try {
      const res = await window.agentui.browserOpen(trimmed)
      setOpenedInfo(`已打开：${res.title || res.url}`)
      setTabs(await window.agentui.browserTabs())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    void refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ego = status?.ego
  const browserMcps = (status?.mcpServers ?? []).filter((s) => s.browserLike)
  const otherMcps = (status?.mcpServers ?? []).filter((s) => !s.browserLike)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620, width: '92vw' }}>
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Globe size={17} color="#60a5fa" />
            <span>浏览器协同</span>
          </h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="icon-btn"
              title="重新探测 ego-browser 与 MCP 配置"
              onClick={() => void refreshStatus(true)}
            >
              <RefreshCw size={13} />
            </button>
            <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={`dot ${ego?.available ? 'dot-ready' : 'dot-missing'}`} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>ego-browser</span>
          {ego?.available ? (
            <span className="mono-chip" title={ego.path ?? ''}>
              v{ego.version ?? '?'} 可用
            </span>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {busy === 'status' ? '探测中…' : ego?.error ?? '未安装（可选组件，安装后可用快捷控制）'}
            </span>
          )}
        </div>

        {ego?.available && (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                className="text-input"
                style={{ flex: 1 }}
                placeholder="https://example.com — 在 ego-browser 工作区空间中打开"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void openUrl()
                }}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || !url.trim()}
                onClick={() => void openUrl()}
              >
                <ExternalLink size={13} />
                {busy === 'open' ? '打开中…' : '打开'}
              </button>
              <button
                type="button"
                className="btn-small"
                disabled={busy !== null || screenshotBusy}
                title="截取当前活动标签页并作为图片附加到输入框"
                onClick={onScreenshot}
              >
                <Camera size={13} />
                {screenshotBusy ? '截图中…' : '截图到输入框'}
              </button>
            </div>

            <div>
              <div className="sidebar-section-header" style={{ padding: '0 0 4px' }}>
                <span>工作区标签页</span>
                <button
                  type="button"
                  className="icon-btn"
                  title="刷新标签页"
                  disabled={busy !== null}
                  onClick={() => void refreshTabs()}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
              {tabs.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '4px 0' }}>
                  {busy === 'tabs' ? '读取中…' : '暂无标签页。输入 URL 打开第一个页面。'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
                  {tabs.map((t, i) => (
                    <div key={`${t.label ?? 'tab'}-${i}`} className="thread-row" style={{ cursor: 'default' }}>
                      <div className="thread-main">
                        <div className="thread-title">
                          {t.active && <span className="dot dot-ready" />}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title || t.url}</span>
                        </div>
                        <div className="thread-sub">
                          {t.label && <span className="branch-tag">{t.label}</span>}
                          <span className="branch-tag" title={t.url} style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {t.url}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div>
          <div className="sidebar-section-header" style={{ padding: '0 0 4px' }}>
            <span>浏览器型 MCP ({browserMcps.length})</span>
          </div>
          {browserMcps.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '2px 0' }}>
              未在 ~/.claude.json、项目 .mcp.json、~/.codex/config.toml、~/.gemini/settings.json 中发现浏览器型 MCP 服务器。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {browserMcps.map((s) => (
                <div key={`${s.source}-${s.name}`} className="thread-row" style={{ cursor: 'default' }}>
                  <div className="thread-main">
                    <div className="thread-title">
                      <span className="dot dot-ready" />
                      {s.name}
                    </div>
                    <div className="thread-sub">
                      <span className="branch-tag" title={s.source} style={{ maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.command ? [s.command, ...(s.args ?? [])].join(' ') : s.url}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {otherMcps.length > 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 4 }}>
              另有 {otherMcps.length} 个非浏览器型 MCP 服务器（{otherMcps.map((s) => s.name).slice(0, 6).join('、')}
              {otherMcps.length > 6 ? ' 等' : ''}）。
            </div>
          )}
          <div style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
            MCP 服务器仅展示发现状态，由各引擎自行连接使用；快捷控制（打开 / 标签页 / 截图）通过 ego-browser 执行。
          </div>
        </div>

        {openedInfo && <div style={{ color: '#34d399', fontSize: 12 }}>{openedInfo}</div>}
        {error && <div style={{ color: '#fca5a5', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
      </div>
    </div>
  )
}