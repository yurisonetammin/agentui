import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronRight, Columns2, FolderGit2, FolderPlus, GitFork, History, Keyboard, Loader2, Plus, RefreshCw, Search, Settings, Shield, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { relativeTime, statusDotClass, statusLabel } from '../workbench'
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  type CliSessionSummary,
  type ExtensionUiRequest,
  type HarnessId,
  type HarnessStatus,
  type ProjectEntry,
  type ThreadEntry,
} from '@shared/types'
import { TRUST_PRESET_LABELS, type TrustPreset } from '@shared/tool-policy'

function trustIcon(preset: TrustPreset) {
  if (preset === 'readonly') return <ShieldCheck size={13} color="var(--success)" />
  if (preset === 'auto') return <ShieldAlert size={13} color="var(--warning)" />
  return <Shield size={13} />
}

const ENGINE_MARKS: Record<HarnessId, string> = { pi: 'π', omp: 'O', prime: 'P', claude: 'C', codex: 'Cx', acp: 'A', dsh: 'D' }

export function Sidebar({
  harnesses,
  activeHarness,
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  splitThreadId,
  pendingUiQueue,
  cliSessions,
  onSelectHarness,
  onRefreshHarnesses,
  onOpenShortcuts,
  onOpenSettings,
  onOpenPalette,
  onStartDraft,
  onAddProject,
  onRemoveProject,
  onOpenTrust,
  onNewThread,
  onSelectThread,
  onOpenInSplit,
  onDeleteThread,
  onRenameThread,
  onResumeCliSession,
  onRefreshCliSessions,
}: {
  harnesses: Record<HarnessId, HarnessStatus>
  activeHarness: HarnessId
  projects: ProjectEntry[]
  threads: ThreadEntry[]
  activeProjectId: string | null
  activeThreadId: string | null
  splitThreadId?: string | null
  pendingUiQueue?: readonly ExtensionUiRequest[]
  cliSessions: CliSessionSummary[]
  onSelectHarness: (id: HarnessId) => void
  onRefreshHarnesses: () => void
  onOpenShortcuts: () => void
  onOpenSettings: () => void
  onOpenPalette: () => void
  onStartDraft: () => void
  onAddProject: () => void
  onRemoveProject: (id: string) => void
  onOpenTrust: (projectId: string) => void
  onNewThread: (projectId: string, harness: HarnessId) => void
  onSelectThread: (threadId: string) => void
  onOpenInSplit?: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
  onResumeCliSession: (session: CliSessionSummary) => void
  onRefreshCliSessions: () => void
}) {
  const [showCliSessions, setShowCliSessions] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(Date.now)
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const cancelRenameRef = useRef(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (activeThreadId && activeProjectId) {
      setCollapsedProjects((prev) => prev[activeProjectId] ? { ...prev, [activeProjectId]: false } : prev)
    }
  }, [activeThreadId, activeProjectId])

  function startRename(thread: ThreadEntry) {
    cancelRenameRef.current = false
    setEditingThreadId(thread.id)
    setEditingTitle(thread.title)
  }

  function commitRename(thread: ThreadEntry) {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      setEditingThreadId(null)
      return
    }
    const trimmed = editingTitle.trim()
    setEditingThreadId(null)
    if (trimmed && trimmed !== thread.title) {
      onRenameThread(thread.id, trimmed)
    }
  }

  const pendingByThread = new Map<string, number>()
  for (const req of pendingUiQueue ?? []) {
    pendingByThread.set(req.threadId, (pendingByThread.get(req.threadId) ?? 0) + 1)
  }
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]))
  const waitingThreads = threads.filter(
    (t) => t.status === 'waiting_ui' || (pendingByThread.get(t.id) ?? 0) > 0,
  )
  const runningThreads = threads.filter(
    (t) =>
      !waitingThreads.some((w) => w.id === t.id) &&
      (t.status === 'streaming' || t.status === 'starting' || t.status === 'compacting'),
  )
  const hasLiveStatus = waitingThreads.length > 0 || runningThreads.length > 0

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button type="button" className="sidebar-search" onClick={onOpenPalette}>
          <Search size={14} /><span>搜索会话</span><kbd>Ctrl K</kbd>
        </button>
        <button type="button" className="icon-btn" title="新建会话" aria-label="新建会话" onClick={onStartDraft}><Plus size={17} /></button>
      </div>

      {hasLiveStatus && (
        <section className="sidebar-live-bar" aria-label="后台任务与待审批状态">
          <div className="sidebar-live-summary">
            {waitingThreads.length > 0 && (
              <span className="sidebar-live-pill is-waiting">
                <AlertCircle size={12} />
                待审批 {waitingThreads.length}
              </span>
            )}
            {runningThreads.length > 0 && (
              <span className="sidebar-live-pill is-running">
                <Loader2 size={12} className="spin" />
                运行中 {runningThreads.length}
              </span>
            )}
          </div>
          <div className="sidebar-live-list">
            {waitingThreads.map((t) => (
              <button
                key={`wait-${t.id}`}
                type="button"
                className={`sidebar-live-item is-waiting${activeThreadId === t.id ? ' active' : ''}`}
                title={`点击跳转到「${t.title}」处理审批`}
                onClick={() => {
                  setCollapsedProjects((prev) => ({ ...prev, [t.projectId]: false }))
                  onSelectThread(t.id)
                }}
              >
                <span className="dot dot-waiting" />
                <span className="sidebar-live-title">{t.title}</span>
                <span className="sidebar-live-project">{projectNameById.get(t.projectId) ?? ''}</span>
              </button>
            ))}
            {runningThreads.map((t) => (
              <button
                key={`run-${t.id}`}
                type="button"
                className={`sidebar-live-item is-running${activeThreadId === t.id ? ' active' : ''}`}
                title={`点击查看运行中的会话「${t.title}」`}
                onClick={() => {
                  setCollapsedProjects((prev) => ({ ...prev, [t.projectId]: false }))
                  onSelectThread(t.id)
                }}
              >
                <span className="dot dot-streaming" />
                <span className="sidebar-live-title">{t.title}</span>
                <span className="sidebar-live-project">{projectNameById.get(t.projectId) ?? ''}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="sidebar-scroll">
        <div className="sidebar-section-header">
          <span>项目与会话</span>
          <button type="button" className="btn-small" onClick={onAddProject}>
            <FolderPlus size={12} />
            添加项目
          </button>
        </div>

        {projects.map((project) => {
          const projectThreads = threads.filter((t) => t.projectId === project.id).sort((a, b) => b.updatedAt - a.updatedAt)
          const expanded = !collapsedProjects[project.id]

          return (
            <div key={project.id} className="project-card">
              <div className={`project-row ${activeProjectId === project.id ? 'active' : ''}`}>
                <button type="button" className="project-name" title={project.path} aria-expanded={expanded}
                  aria-controls={`threads-${project.id}`}
                  onClick={() => setCollapsedProjects((prev) => ({ ...prev, [project.id]: expanded }))}>
                  <ChevronRight size={13} className={expanded ? 'project-chevron expanded' : 'project-chevron'} />
                  <FolderGit2 size={14} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
                </button>
                <div className="project-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={`权限预设：${TRUST_PRESET_LABELS[project.trustPreset ?? 'approval']}（点击配置）`}
                    onClick={() => onOpenTrust(project.id)}
                  >
                    {trustIcon(project.trustPreset ?? 'approval')}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={`用 ${HARNESS_LABELS[activeHarness]} 新建对话`}
                    onClick={() => {
                      setCollapsedProjects((prev) => ({ ...prev, [project.id]: false }))
                      onNewThread(project.id, activeHarness)
                    }}
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="移除项目"
                    onClick={() => onRemoveProject(project.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div className="thread-list" id={`threads-${project.id}`} hidden={!expanded}>
                {projectThreads.map((t) => {
                  const isEditing = editingThreadId === t.id
                  return (
                    <div
                      key={t.id}
                      className={`thread-row ${activeThreadId === t.id ? 'active' : ''}`}
                      onClick={() => {
                        if (!isEditing) onSelectThread(t.id)
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        startRename(t)
                      }}
                      title={`${t.title} · ${HARNESS_LABELS[t.harness]} · ${statusLabel(t.status)}${t.worktreeBranch ? ` · ${t.worktreeBranch}` : ''}\n双击重命名`}
                      role="button"
                      tabIndex={0}
                      aria-current={activeThreadId === t.id ? 'true' : undefined}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && !isEditing && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault()
                          onSelectThread(t.id)
                        }
                      }}
                    >
                      <div className="thread-main">
                        <div className="thread-title">
                          <span className={`dot ${statusDotClass(t.status)}`} />
                          {isEditing ? (
                            <input
                              type="text"
                              className="inline-rename-input"
                              autoFocus
                              value={editingTitle}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                e.stopPropagation()
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  commitRename(t)
                                } else if (e.key === 'Escape') {
                                  e.preventDefault()
                                  cancelRenameRef.current = true
                                  setEditingThreadId(null)
                                }
                              }}
                              onBlur={() => commitRename(t)}
                            />
                          ) : (
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                          )}
                        </div>
                      </div>
                      {t.parentThreadId && <span className="fork-tag" title="分叉会话" aria-label="分叉会话"><GitFork size={11} /></span>}
                      {splitThreadId === t.id && <span className="split-tag" title="正在右侧分屏显示">分屏</span>}
                      <time className="thread-time" dateTime={new Date(t.updatedAt).toISOString()}>{relativeTime(t.updatedAt, now)}</time>
                      {onOpenInSplit && t.id !== activeThreadId && (
                        <button
                          type="button"
                          className="icon-btn thread-split-btn"
                          title="在右侧分屏打开"
                          aria-label={`在右侧分屏打开 ${t.title}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenInSplit(t.id)
                          }}
                        >
                          <Columns2 size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn thread-remove"
                        title="删除对话"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteThread(t.id)
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div className="sidebar-section-header">
            <button
              type="button"
              style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'inherit', fontWeight: 600 }}
              onClick={() => {
                const next = !showCliSessions
                setShowCliSessions(next)
                if (next) onRefreshCliSessions()
              }}
            >
              <History size={12} />
              <span>CLI 历史会话 ({cliSessions.length})</span>
            </button>
            {showCliSessions && (
              <button type="button" className="icon-btn" onClick={onRefreshCliSessions} title="刷新">
                <RefreshCw size={12} />
              </button>
            )}
          </div>
          {showCliSessions && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {cliSessions.slice(0, 12).map((s) => (
                <button
                  key={s.sessionPath}
                  type="button"
                  className="thread-row"
                  title={`${s.cwd}\n${s.sessionPath}`}
                  onClick={() => onResumeCliSession(s)}
                >
                  <div className="thread-main">
                    <div className="thread-title">{s.title}</div>
                    <div className="thread-sub">
                      <span className={`harness-tag tag-${s.harness}`}>
                        {s.harness === 'prime' ? 'Prime' : HARNESS_LABELS[s.harness]}
                      </span>
                      <span className="branch-tag">{s.cwd || 'unknown cwd'}</span>
                    </div>
                  </div>
                </button>
              ))}
              {cliSessions.length === 0 && (
                <div style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 12.5 }}>
                  暂未扫描到历史 `.jsonl` 会话。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className="sidebar-footer">
        <div className="engine-strip" role="group" aria-label="引擎状态">
          {HARNESS_IDS.map((id) => {
            const status = harnesses[id]
            const label = `${HARNESS_LABELS[id]} · ${status?.ready ? status.version ?? '就绪' : '未就绪'}`
            return (
              <button key={id} type="button" className={`engine-pill ${activeHarness === id ? 'active' : ''}`}
                aria-label={label} aria-pressed={activeHarness === id} title={status?.path ? `${label}\n${status.path}` : label}
                onClick={() => onSelectHarness(id)}>
                <span className={`engine-mark tag-${id}`}>{ENGINE_MARKS[id]}</span>
                <span className={`dot ${status?.ready ? 'dot-ready' : 'dot-idle'}`} />
              </button>
            )
          })}
        </div>
        <div className="sidebar-footer-actions">
          <button type="button" className="icon-btn" title="设置 (Ctrl+,)" aria-label="设置" onClick={onOpenSettings}><Settings size={15} /></button>
          <button type="button" className="icon-btn" title="重新探测引擎" aria-label="重新探测引擎" onClick={onRefreshHarnesses}><RefreshCw size={14} /></button>
          <button type="button" className="icon-btn" title="快捷键 (Ctrl+/)" aria-label="快捷键" onClick={onOpenShortcuts}><Keyboard size={16} /></button>
        </div>
      </footer>
    </aside>
  )
}
