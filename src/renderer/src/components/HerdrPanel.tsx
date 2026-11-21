// 终端面板的「Herdr」视图：按项目工作目录映射 Herdr 工作区，展示标签页/分屏与
// Agent 状态，提供只读快照预览、内嵌实时终端、手动关联与「在 Herdr 中新建会话」。
// Herdr 进程本身完全由 Herdr 服务管理；这里只做发现、观察与显式启动。

import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderTree, ExternalLink, RefreshCw, Plus, Unlink, SquareTerminal } from 'lucide-react'
import { HerdrTerminalView } from './HerdrTerminalView'
import { errorText } from './SettingsControls'
import {
  HERDR_AGENT_KINDS,
  HERDR_AGENT_KIND_LABELS,
  HERDR_STATUS_LABELS,
  matchWorkspaceForProject,
  type HerdrAssociation,
  type HerdrLaunchKind,
  type HerdrPaneInfo,
  type HerdrPaneStatus,
  type HerdrSnapshotView,
  type HerdrStatusReport,
} from '@shared/herdr'

interface HerdrPanelProps {
  cwd: string | null
  projectId: string | null
  projectName: string | null
  visible: boolean
}

const SNAPSHOT_POLL_MS = 5_000

function StatusDot({ status }: { status: HerdrPaneStatus }) {
  return <span className={`herdr-dot herdr-dot-${status}`} title={HERDR_STATUS_LABELS[status]} />
}

export function HerdrPanel({ cwd, projectId, projectName, visible }: HerdrPanelProps) {
  const [report, setReport] = useState<HerdrStatusReport | null>(null)
  const [snapshot, setSnapshot] = useState<HerdrSnapshotView | null>(null)
  const [associations, setAssociations] = useState<Record<string, HerdrAssociation>>({})
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null)
  const [showLive, setShowLive] = useState(false)
  const [preview, setPreview] = useState<{ text: string; paneId: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [othersOpen, setOthersOpen] = useState(false)

  const snapshotReqRef = useRef(0)
  const previewReqRef = useRef(0)

  const note = useCallback((kind: 'ok' | 'err', text: string) => {
    setFeedback({ kind, text })
  }, [])

  const refreshSnapshot = useCallback(async (refreshStatus = false) => {
    const request = ++snapshotReqRef.current
    try {
      const nextReport = await window.agentui.herdrStatus(refreshStatus)
      if (request !== snapshotReqRef.current) return
      if (!nextReport.server.running) {
        setReport(nextReport)
        setSnapshot(null)
        return
      }
      const nextSnapshot = await window.agentui.herdrSnapshot(nextReport.connectionId)
      if (request !== snapshotReqRef.current) return
      setReport(nextReport)
      setSnapshot(nextSnapshot)
    } catch (err) {
      if (request === snapshotReqRef.current) setFeedback({ kind: 'err', text: errorText(err) })
    }
  }, [])

  useEffect(() => {
    void window.agentui.getState().then((state) => setAssociations(state.herdr.associations)).catch(() => undefined)
  }, [])

  useEffect(() => {
    const unsubscribe = window.agentui.onHerdrConnectionChanged(() => {
      previewReqRef.current += 1
      setReport(null)
      setSnapshot(null)
      setSelectedPaneId(null)
      setShowLive(false)
      setPreview(null)
      setFeedback(null)
      void refreshSnapshot()
    })
    void refreshSnapshot()
    return () => {
      snapshotReqRef.current += 1
      previewReqRef.current += 1
      unsubscribe()
    }
  }, [refreshSnapshot])

  // 仅在面板可见时轻量轮询，保持 Agent 状态徽标新鲜。
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => void refreshSnapshot(), SNAPSHOT_POLL_MS)
    return () => clearInterval(timer)
  }, [visible, refreshSnapshot])

  // 只读快照预览跟随选中的面板。
  useEffect(() => {
    if (showLive || !selectedPaneId) return
    const request = ++previewReqRef.current
    window.agentui.herdrReadPane(selectedPaneId, 'visible')
      .then((text) => {
        if (request === previewReqRef.current) setPreview({ text, paneId: selectedPaneId })
      })
      .catch((err) => {
        if (request === previewReqRef.current) setPreview({ text: `读取失败：${errorText(err)}`, paneId: selectedPaneId })
      })
  }, [selectedPaneId, showLive])

  const association = projectId ? associations[projectId] ?? null : null
  const matched = snapshot && cwd ? matchWorkspaceForProject(snapshot, cwd, association) : null
  const panesOf = useCallback((workspaceId: string) => snapshot?.panes.filter((p) => p.workspaceId === workspaceId) ?? [], [snapshot])
  const tabsOf = useCallback((workspaceId: string) => snapshot?.tabs.filter((t) => t.workspaceId === workspaceId) ?? [], [snapshot])
  const otherWorkspaces = snapshot
    ? snapshot.workspaces.filter((w) => w.workspaceId !== matched?.workspaceId)
    : []
  const selectedPane = snapshot?.panes.find((p) => p.paneId === selectedPaneId) ?? null
  const projectLabel = projectName?.trim() || 'agentui'

  const act = useCallback(async (id: string, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(id)
    setFeedback(null)
    try {
      await fn()
    } catch (err) {
      note('err', errorText(err))
    } finally {
      setBusy(null)
    }
  }, [busy, note])

  const handleStartServer = () => act('server', async () => {
    await window.agentui.herdrStartServer()
    await refreshSnapshot()
    note('ok', 'Herdr 服务已启动')
  })

  const handleCreateWorkspace = () => act('create', async () => {
    if (!cwd) throw new Error('请先选择一个项目')
    const created = await window.agentui.herdrCreateWorkspace(cwd, projectLabel)
    await refreshSnapshot()
    if (projectId) {
      const assoc: HerdrAssociation = { workspaceId: created.workspaceId, label: projectLabel, cwd, savedAt: Date.now() }
      const next = await window.agentui.herdrSetAssociation(projectId, assoc)
      setAssociations(next.associations)
    }
    setSelectedPaneId(created.paneId)
    note('ok', `已创建 Herdr 工作区「${projectLabel}」`)
  })

  const handleAssociate = (workspaceId: string) => act(`assoc-${workspaceId}`, async () => {
    if (!projectId) throw new Error('请先选择一个项目')
    const workspace = snapshot?.workspaces.find((w) => w.workspaceId === workspaceId)
    const next = await window.agentui.herdrSetAssociation(projectId, {
      workspaceId,
      label: workspace?.label ?? '未命名',
      cwd: cwd ?? '',
      savedAt: Date.now(),
    })
    setAssociations(next.associations)
    note('ok', `已关联工作区「${workspace?.label ?? workspaceId}」`)
  })

  const handleClearAssociation = () => act('clear-assoc', async () => {
    if (!projectId) return
    const next = await window.agentui.herdrSetAssociation(projectId, null)
    setAssociations(next.associations)
    note('ok', '已清除手动关联，恢复按目录自动匹配')
  })

  const handleLaunch = (kind: HerdrLaunchKind) => act(`launch-${kind}`, async () => {
    if (!cwd) throw new Error('请先选择一个项目')
    const result = await window.agentui.herdrLaunchAgent(kind, cwd, projectLabel, projectId)
    await refreshSnapshot()
    if (result.ok) {
      if (result.paneId) setSelectedPaneId(result.paneId)
      note('ok', kind === 'prime'
        ? '已在 Herdr 新标签页运行 prime-agent'
        : `已在 Herdr 新标签页启动 ${HERDR_AGENT_KIND_LABELS[kind]}${result.agentName ? `（${result.agentName}）` : ''}`)
    } else {
      throw new Error(result.error ?? '启动失败')
    }
  })

  const handleOpenExternally = (pane: HerdrPaneInfo) => act(`focus-${pane.paneId}`, async () => {
    await window.agentui.herdrFocusTab(pane.tabId)
    note('ok', '已在 Herdr 中定位该面板所在标签页（若 TUI 未连接，先运行 herdr attach 查看）')
  })

  const renderPaneRow = (pane: HerdrPaneInfo) => (
    <li key={pane.paneId} className={`herdr-pane-row ${selectedPaneId === pane.paneId ? 'is-selected' : ''}`}>
      <button type="button" className="herdr-pane-btn" onClick={() => { setSelectedPaneId(pane.paneId); setShowLive(false) }}>
        <StatusDot status={pane.agentStatus} />
        <span className="herdr-pane-name">{pane.label ?? pane.paneId}</span>
        {pane.cwd && <span className="herdr-pane-cwd" title={pane.cwd}>{pane.cwd.split(/[\\/]/).pop()}</span>}
      </button>
      <button type="button" className="icon-btn" title="在 Herdr 中打开" aria-label="在 Herdr 中打开"
        disabled={busy === `focus-${pane.paneId}`}
        onClick={() => void handleOpenExternally(pane)}>
        <ExternalLink size={13} />
      </button>
    </li>
  )

  const renderWorkspace = (workspaceId: string, withTabs: boolean) => {
    const workspace = snapshot?.workspaces.find((w) => w.workspaceId === workspaceId)
    if (!workspace) return null
    const tabs = tabsOf(workspaceId)
    return (
      <div key={workspaceId} className="herdr-workspace">
        <div className="herdr-workspace-head">
          <FolderTree size={13} />
          <span className="herdr-workspace-name" title={workspace.label}>{workspace.label}</span>
          <StatusDot status={workspace.agentStatus} />
          <span className="herdr-workspace-meta">{workspace.paneCount} 面板</span>
        </div>
        {withTabs && (
          <ul className="herdr-pane-list">
            {tabs.length > 1
              ? tabs.flatMap((tab) => panesOf(workspaceId)
                  .filter((pane) => pane.tabId === tab.tabId)
                  .map((pane) => (
                    <li key={tab.tabId} className="herdr-tab-group">
                      <span className="herdr-tab-label">标签 {tab.number} · {tab.label}</span>
                      <ul>{renderPaneRow(pane)}</ul>
                    </li>
                  )))
              : panesOf(workspaceId).map((pane) => renderPaneRow(pane))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="herdr-panel">
      <div className="herdr-toolbar">
        <span className="herdr-server-state">
          {report
            ? (report.server.running
              ? <>Herdr 服务运行中{report.server.version ? ` · v${report.server.version}` : ''}{report.session === 'agentui' ? ' · 独立会话' : ''}</>
              : <>Herdr 服务未运行{report.status.available ? '' : ` · ${report.status.error ?? 'CLI 未找到'}`}</>)
            : '正在检测 Herdr…'}
        </span>
        <div className="herdr-toolbar-actions">
          {report && !report.server.running && report.status.available && (
            <button type="button" className="btn" disabled={busy === 'server'} onClick={handleStartServer}>启动服务</button>
          )}
          <button type="button" className="icon-btn" title="刷新" aria-label="刷新 Herdr 状态"
            disabled={busy === 'refresh'}
            onClick={() => act('refresh', () => refreshSnapshot(true))}>
            <RefreshCw size={13} className={busy === 'refresh' ? 'spin' : undefined} />
          </button>
        </div>
      </div>
      {feedback && <p className={`settings-feedback ${feedback.kind === 'ok' ? 'is-success' : 'is-error'}`} role="status">{feedback.text}</p>}

      {!cwd && <p className="panel-placeholder">请选择一个项目以映射 Herdr 工作区。</p>}

      {cwd && report && !report.status.available && (
        <p className="panel-placeholder">未检测到 herdr CLI。可在「设置 → Herdr」中指定路径。</p>
      )}

      {cwd && report?.status.available && (
        <>
          <div className="herdr-project-section">
            <div className="herdr-section-head">
              <span>当前项目 · {projectLabel}</span>
              <div className="herdr-section-actions">
                {association && (
                  <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => void handleClearAssociation()}>
                    <Unlink size={12} /> 清除关联
                  </button>
                )}
                {!matched && (
                  <button type="button" className="btn" disabled={!!busy || !report.server.running} onClick={handleCreateWorkspace}>
                    <Plus size={12} /> 新建工作区
                  </button>
                )}
              </div>
            </div>
            {!report.server.running && (
              <p className="panel-placeholder">Herdr 服务未运行——终端进程由 Herdr 管理，启动后即可连接。</p>
            )}
            {report.server.running && matched && renderWorkspace(matched.workspaceId, true)}
            {report.server.running && !matched && (
              <div className="herdr-associate">
                <p className="panel-placeholder">没有与当前目录匹配的 Herdr 工作区。可手动关联：</p>
                <div className="herdr-associate-list">
                  {snapshot?.workspaces.map((w) => (
                    <button key={w.workspaceId} type="button" className="btn btn-ghost" disabled={!!busy}
                      onClick={() => void handleAssociate(w.workspaceId)}>
                      {w.label}
                    </button>
                  ))}
                  {snapshot && snapshot.workspaces.length === 0 && <span className="panel-placeholder">Herdr 暂无工作区。</span>}
                </div>
              </div>
            )}
            <div className="herdr-launch-row">
              <span className="herdr-launch-label">在 Herdr 中新建会话：</span>
              {HERDR_AGENT_KINDS.map((kind) => (
                <button key={kind} type="button" className="btn" disabled={!!busy || !report.server.running}
                  onClick={() => void handleLaunch(kind)}>
                  <SquareTerminal size={12} /> {HERDR_AGENT_KIND_LABELS[kind]}
                </button>
              ))}
            </div>
          </div>

          {otherWorkspaces.length > 0 && (
            <div className="herdr-others">
              <button type="button" className="herdr-others-toggle" onClick={() => setOthersOpen((v) => !v)}>
                {othersOpen ? '▾' : '▸'} 其他工作区（{otherWorkspaces.length}）
              </button>
              {othersOpen && otherWorkspaces.map((w) => renderWorkspace(w.workspaceId, true))}
            </div>
          )}

          {selectedPane && (
            <div className="herdr-inspector">
              <div className="herdr-inspector-head">
                <StatusDot status={selectedPane.agentStatus} />
                <span className="herdr-inspector-title">{selectedPane.label ?? selectedPane.paneId}</span>
                <span className="herdr-inspector-meta">{selectedPane.paneId} · {HERDR_STATUS_LABELS[selectedPane.agentStatus]}</span>
                <div className="herdr-inspector-actions">
                  <button type="button" className={`btn btn-ghost ${!showLive ? 'is-active' : ''}`} onClick={() => setShowLive(false)}>快照</button>
                  <button type="button" className={`btn btn-ghost ${showLive ? 'is-active' : ''}`} onClick={() => setShowLive(true)}>
                    <SquareTerminal size={12} /> 实时终端
                  </button>
                </div>
              </div>
              {showLive && visible
                ? <HerdrTerminalView key={`${report.connectionId}:${selectedPane.paneId}`} connectionId={report.connectionId}
                    paneId={selectedPane.paneId} label={selectedPane.label} />
                : (
                  <div className="herdr-preview-wrap">
                    <div className="herdr-preview-head">
                      <span>只读快照（herdr pane read）</span>
                      <button type="button" className="icon-btn" title="刷新快照" aria-label="刷新快照"
                        onClick={() => { const id = selectedPane.paneId; setPreview(null); setSelectedPaneId(null); setTimeout(() => setSelectedPaneId(id), 0) }}>
                        <RefreshCw size={12} />
                      </button>
                    </div>
                    <pre className="herdr-preview">{preview?.paneId === selectedPane.paneId ? preview.text : '读取中…'}</pre>
                  </div>
                )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
