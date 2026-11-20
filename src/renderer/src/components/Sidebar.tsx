import { useRef, useState, type RefObject } from 'react'
import { FolderGit2, FolderPlus, GitFork, History, Keyboard, Plus, RefreshCw, Search, Settings, Shield, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react'
import brandIcon from '../assets/brand-icon.png'
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  type CliSessionSummary,
  type HarnessId,
  type HarnessStatus,
  type ProjectEntry,
  type ThreadEntry,
} from '@shared/types'
import { TRUST_PRESET_LABELS, type TrustPreset } from '@shared/tool-policy'

function trustIcon(preset: TrustPreset) {
  if (preset === 'readonly') return <ShieldCheck size={13} color="#34d399" />
  if (preset === 'auto') return <ShieldAlert size={13} color="#fbbf24" />
  return <Shield size={13} color="#9aa7bd" />
}

function statusDotClass(status: ThreadEntry['status']): string {
  if (status === 'streaming' || status === 'starting' || status === 'compacting') return 'dot-streaming'
  if (status === 'waiting_ui') return 'dot-waiting'
  if (status === 'disconnected') return 'dot-disconnected'
  if (status === 'error') return 'dot-error'
  return 'dot-idle'
}

export function Sidebar({
  harnesses,
  activeHarness,
  projects,
  threads,
  activeProjectId,
  activeThreadId,
  cliSessions,
  onSelectHarness,
  onRefreshHarnesses,
  onOpenShortcuts,
  onOpenSettings,
  filterInputRef,
  onAddProject,
  onRemoveProject,
  onOpenTrust,
  onNewThread,
  onSelectThread,
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
  cliSessions: CliSessionSummary[]
  onSelectHarness: (id: HarnessId) => void
  onRefreshHarnesses: () => void
  onOpenShortcuts: () => void
  onOpenSettings: () => void
  filterInputRef?: RefObject<HTMLInputElement | null>
  onAddProject: () => void
  onRemoveProject: (id: string) => void
  onOpenTrust: (projectId: string) => void
  onNewThread: (projectId: string, harness: HarnessId) => void
  onSelectThread: (threadId: string) => void
  onDeleteThread: (threadId: string) => void
  onRenameThread: (threadId: string, title: string) => void
  onResumeCliSession: (session: CliSessionSummary) => void
  onRefreshCliSessions: () => void
}) {
  const [showCliSessions, setShowCliSessions] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const cancelRenameRef = useRef(false)

  const query = filterText.trim().toLowerCase()

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

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <img src={brandIcon} alt="AgentUI" className="brand-icon" />
          <span>AgentUI</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="icon-btn" title="重新探测 CLI" onClick={onRefreshHarnesses}>
            <RefreshCw size={14} />
          </button>
          <button type="button" className="icon-btn" title="快捷键 (Ctrl+/)" onClick={onOpenShortcuts}>
            <Keyboard size={14} />
          </button>
          <button type="button" className="icon-btn" title="引擎路径与环境 (Ctrl+,)" onClick={onOpenSettings}>
            <Settings size={14} />
          </button>
        </div>
      </div>

      <div className="engine-strip">
        {HARNESS_IDS.map((id) => {
          const st = harnesses[id]
          const isActive = activeHarness === id
          return (
            <button
              key={id}
              type="button"
              className={`engine-pill ${isActive ? 'active' : ''}`}
              title={st?.path ? `${st.name} ${st.version ?? ''}\n${st.path}` : st?.error ?? '未检测到'}
              onClick={() => onSelectHarness(id)}
            >
              <span className="engine-pill-top">
                <span className={`dot ${st?.ready ? 'dot-ready' : 'dot-missing'}`} />
                <span>{id === 'prime' ? 'Prime' : HARNESS_LABELS[id]}</span>
              </span>
              <span className="engine-pill-ver">{st?.ready ? st.version ?? 'ready' : '未就绪'}</span>
            </button>
          )
        })}
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section-header">
          <span>项目与会话</span>
          <button type="button" className="btn-small" onClick={onAddProject}>
            <FolderPlus size={12} />
            添加项目
          </button>
        </div>

        <div className="sidebar-filter">
          <Search size={12} color="var(--text-muted)" style={{ flexShrink: 0 }} />
          <input
            ref={filterInputRef}
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="过滤项目 / 会话 / 分支 (Ctrl+K)"
          />
          {filterText && (
            <button
              type="button"
              className="icon-btn"
              style={{ width: 20, height: 20 }}
              title="清除筛选"
              onClick={() => setFilterText('')}
            >
              <X size={11} />
            </button>
          )}
        </div>

        {projects.length === 0 && (
          <div style={{ padding: '14px 8px', color: 'var(--text-muted)', fontSize: 12 }}>
            点击右上角「添加项目」，选择一个本地 Git 仓库即可开始。
          </div>
        )}

        {projects.map((project) => {
          const projectThreads = threads.filter((t) => t.projectId === project.id)
          const projectMatches =
            !query ||
            project.name.toLowerCase().includes(query) ||
            project.path.toLowerCase().includes(query)
          const visibleThreads = projectMatches
            ? projectThreads
            : projectThreads.filter(
                (t) =>
                  t.title.toLowerCase().includes(query) ||
                  (t.worktreeBranch?.toLowerCase().includes(query) ?? false) ||
                  t.harness.toLowerCase().includes(query) ||
                  t.cwd.toLowerCase().includes(query),
              )
          if (query && !projectMatches && visibleThreads.length === 0) return null

          return (
            <div key={project.id} className="project-card">
              <div className={`project-row ${activeProjectId === project.id ? 'active' : ''}`}>
                <div className="project-name" title={project.path}>
                  <FolderGit2 size={14} color="#9aa7bd" style={{ flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
                </div>
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
                    onClick={() => onNewThread(project.id, activeHarness)}
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

              <div className="thread-list">
                {visibleThreads.map((t) => {
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
                      title="双击可重命名会话"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (!isEditing && (e.key === 'Enter' || e.key === ' ')) onSelectThread(t.id)
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
                        <div className="thread-sub">
                          <span className={`harness-tag tag-${t.harness}`}>
                            {t.harness === 'prime' ? 'Prime' : HARNESS_LABELS[t.harness]}
                          </span>
                          {t.parentThreadId && (
                            <span className="fork-tag" title="分叉自父会话">
                              <GitFork size={9} />
                              分叉
                            </span>
                          )}
                          {t.worktreeBranch && <span className="branch-tag">⎇ {t.worktreeBranch}</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
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
                <div style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 11.5 }}>
                  暂未扫描到历史 `.jsonl` 会话。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
