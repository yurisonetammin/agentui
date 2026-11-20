import { useEffect, useRef, useState } from 'react'
import { Check, GitBranch, MessageSquarePlus, Minus, Plus, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react'
import type { GitFileChange, GitStatusSummary } from '@shared/types'

function DiffLines({ diffText }: { diffText: string }) {
  if (!diffText.trim()) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)' }}>
        选择上方文件查看变更 Diff（当前文件无文本差异）。
      </div>
    )
  }
  return (
    <>
      {diffText.split(/\r?\n/).map((line, idx) => {
        let cls = 'diff-line'
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) {
          cls += ' meta'
        } else if (line.startsWith('@@')) {
          cls += ' hunk'
        } else if (line.startsWith('+')) {
          cls += ' add'
        } else if (line.startsWith('-')) {
          cls += ' del'
        }
        return (
          <div key={idx} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </>
  )
}

export function DiffPanel({
  cwd,
  repoRoot,
  status,
  activeTab,
  onTabChange,
  onRefresh,
  onClose,
  onCreateWorktreeThread,
  onNewThreadInWorktree,
  onRemoveWorktree,
}: {
  cwd: string
  repoRoot?: string
  status: GitStatusSummary | null
  activeTab: 'changes' | 'worktrees'
  onTabChange: (tab: 'changes' | 'worktrees') => void
  onRefresh: () => void
  onClose: () => void
  onCreateWorktreeThread: (branchName: string, baseRef?: string) => Promise<void>
  onNewThreadInWorktree: (worktreePath: string, branch: string | null) => Promise<void>
  onRemoveWorktree: (worktreePath: string) => Promise<void>
}) {
  const [selected, setSelected] = useState<GitFileChange | null>(null)
  const [diffText, setDiffText] = useState('')
  const [commitMsg, setCommitMsg] = useState('')
  const [branchInput, setBranchInput] = useState('')
  const [baseRefInput, setBaseRefInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const diffReqIdRef = useRef(0)

  useEffect(() => {
    diffReqIdRef.current += 1
    setSelected(null)
    setDiffText('')
  }, [cwd])

  useEffect(() => {
    diffReqIdRef.current += 1
    const reqId = diffReqIdRef.current
    if (!status?.isRepo) {
      setSelected(null)
      setDiffText('')
      return
    }
    const changes = status.changes
    if (changes.length === 0) {
      setSelected(null)
      setDiffText('')
      return
    }
    const match = selected
      ? changes.find((c) => c.path === selected.path && c.staged === selected.staged) ?? changes[0]
      : changes[0]
    setSelected(match)
    void window.agentui
      .gitGetDiff(cwd, match.path, match.staged)
      .then((text) => {
        if (diffReqIdRef.current === reqId) setDiffText(text)
      })
      .catch(() => {
        if (diffReqIdRef.current === reqId) setDiffText('')
      })
  }, [cwd, status])

  async function selectFile(change: GitFileChange) {
    diffReqIdRef.current += 1
    const reqId = diffReqIdRef.current
    setSelected(change)
    try {
      const text = await window.agentui.gitGetDiff(cwd, change.path, change.staged)
      if (diffReqIdRef.current === reqId) setDiffText(text)
    } catch (err) {
      if (diffReqIdRef.current === reqId) {
        setDiffText(err instanceof Error ? err.message : String(err))
      }
    }
  }

  async function runAction(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stagedCount = status?.changes.filter((c) => c.staged).length ?? 0

  return (
    <aside className="diff-panel">
      <div className="panel-tabs">
        <div className="tab-group">
          <button
            type="button"
            className={`tab-btn ${activeTab === 'changes' ? 'active' : ''}`}
            onClick={() => onTabChange('changes')}
          >
            变更 ({status?.changes.length ?? 0})
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'worktrees' ? 'active' : ''}`}
            onClick={() => onTabChange('worktrees')}
          >
            Worktrees ({status?.worktrees.length ?? 0})
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {status?.branch && (
            <span className="mono-chip" style={{ maxWidth: 130 }}>
              <GitBranch size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              {status.branch}
            </span>
          )}
          <button type="button" className="icon-btn" title="刷新 Git 状态" onClick={onRefresh}>
            <RefreshCw size={13} />
          </button>
          <button type="button" className="icon-btn" title="收起面板" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {error && <div className="msg-notice error" style={{ margin: '8px 10px 0' }}>{error}</div>}

      {!status?.isRepo ? (
        <div style={{ padding: 18, color: 'var(--text-muted)' }}>
          当前目录不是 Git 仓库（{status?.error ?? cwd}）。
        </div>
      ) : activeTab === 'changes' ? (
        <>
          <div className="diff-file-list">
            {status.changes.length === 0 && (
              <div style={{ padding: 10, color: 'var(--text-muted)', fontSize: 12 }}>工作区干净，暂无未提交改动。</div>
            )}
            {status.changes.map((c) => {
              const isSelected = selected?.path === c.path && selected?.staged === c.staged
              const badge = c.staged ? `S:${c.indexStatus}` : c.untracked ? 'U' : c.worktreeStatus
              return (
                <div
                  key={`${c.staged ? 's' : 'w'}:${c.path}`}
                  className={`diff-file-row ${isSelected ? 'active' : ''}`}
                >
                  <button type="button" className="diff-file-name" onClick={() => void selectFile(c)} title={c.path}>
                    <span
                      style={{
                        color: c.staged ? 'var(--success)' : c.untracked ? 'var(--warning)' : 'var(--accent)',
                        marginRight: 6,
                        fontWeight: 600,
                      }}
                    >
                      [{badge}]
                    </span>
                    {c.path}
                  </button>
                  <div style={{ display: 'flex', gap: 2 }}>
                    {c.staged ? (
                      <button
                        type="button"
                        className="icon-btn"
                        title="取消暂存 (Unstage)"
                        disabled={busy}
                        onClick={() => void runAction(() => window.agentui.gitUnstageFile(cwd, c.path))}
                      >
                        <Minus size={12} />
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="icon-btn"
                          title="暂存 (Stage)"
                          disabled={busy}
                          onClick={() => void runAction(() => window.agentui.gitStageFile(cwd, c.path))}
                        >
                          <Plus size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="放弃此文件修改"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`确定放弃 ${c.path} 的未暂存修改？`)) {
                              void runAction(() => window.agentui.gitDiscardFile(cwd, c.path, c.untracked))
                            }
                          }}
                        >
                          <RotateCcw size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="diff-viewer">
            <DiffLines diffText={diffText} />
          </div>

          <div className="commit-box">
            <input
              type="text"
              className="text-input"
              placeholder={stagedCount > 0 ? `提交已暂存的 ${stagedCount} 个文件...` : '请先点击 + 暂存文件后再提交'}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={busy || stagedCount === 0 || !commitMsg.trim()}
              onClick={() =>
                void runAction(async () => {
                  await window.agentui.gitCommit(cwd, commitMsg)
                  setCommitMsg('')
                })
              }
            >
              <Check size={13} />
              提交
            </button>
          </div>
        </>
      ) : (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', flex: 1 }}>
          <div
            style={{
              padding: 10,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg-root)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 12 }}>创建隔离 Git Worktree 并开新对话</div>
            <input
              type="text"
              className="text-input"
              placeholder="新分支名（例如 feat/omp-fix）"
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
            />
            <input
              type="text"
              className="text-input"
              placeholder="基线引用（可选，默认当前 HEAD）"
              value={baseRefInput}
              onChange={(e) => setBaseRefInput(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !branchInput.trim()}
              onClick={() =>
                void runAction(async () => {
                  await onCreateWorktreeThread(branchInput.trim(), baseRefInput.trim() || undefined)
                  setBranchInput('')
                  setBaseRefInput('')
                })
              }
            >
              <Plus size={13} />
              创建 Worktree 并启动对话
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {status.worktrees.map((wt) => {
              const isCurrent = wt.path.toLowerCase() === cwd.toLowerCase()
              return (
                <div
                  key={wt.path}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${isCurrent ? 'var(--accent)' : 'var(--border)'}`,
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>
                        {wt.branch || '(detached)'} {wt.isMain ? '· 主工作区' : ''}
                      </span>
                      {isCurrent && (
                        <span className="harness-tag tag-pi" style={{ fontSize: 9.5 }}>
                          当前
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10.5,
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={wt.path}
                    >
                      {wt.path}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn-small"
                      title="切到此 Worktree 新开对话"
                      disabled={busy}
                      onClick={() => void runAction(() => onNewThreadInWorktree(wt.path, wt.branch))}
                    >
                      <MessageSquarePlus size={12} />
                      新对话
                    </button>
                    {!wt.isMain && repoRoot && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除此 Worktree"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`确认删除 Worktree?\n${wt.path}`)) {
                            void runAction(() => onRemoveWorktree(wt.path))
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </aside>
  )
}
