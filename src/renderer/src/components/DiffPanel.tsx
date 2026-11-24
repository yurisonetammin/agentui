import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlignJustify,
  Check,
  Code2,
  Columns2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  Minus,
  PanelBottom,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  buildSideBySideDiffRows,
  formatDiffCommentForComposer,
  parseUnifiedDiffLines,
  summarizeDiffSelection,
  type SideBySideCell,
} from '@shared/diff-lines'
import type { LinkedPullRequest } from '@shared/git-pr'
import type { GitFileChange, GitStatusSummary, HarnessId } from '@shared/types'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'

export const WORKSPACE_TABS = [
  ['changes', '变更'], ['files', '文件'], ['terminal', '终端'], ['browser', '浏览器'], ['worktrees', '工作树'],
] as const
export type WorkspacePanelTab = (typeof WORKSPACE_TABS)[number][0]

function DiffLines({
  diffText,
  filePath,
  viewMode = 'unified',
  onInsertComment,
}: {
  diffText: string
  filePath?: string | null
  viewMode?: 'unified' | 'split'
  onInsertComment?: (formatted: string) => void
}) {
  const parsed = useMemo(() => parseUnifiedDiffLines(diffText, filePath), [diffText, filePath])
  const splitRows = useMemo(
    () => (viewMode === 'split' ? buildSideBySideDiffRows(parsed) : []),
    [parsed, viewMode],
  )
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null)
  const [commentText, setCommentText] = useState('')
  const draggingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setSelection(null)
    setCommentText('')
  }, [diffText, filePath])

  useEffect(() => {
    const endDrag = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    }
    window.addEventListener('pointerup', endDrag)
    return () => window.removeEventListener('pointerup', endDrag)
  }, [])

  if (!diffText.trim() || parsed.length === 0) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)' }}>
        选择上方文件查看变更 Diff（当前文件无文本差异）。
      </div>
    )
  }

  const selMin = selection ? Math.min(selection.anchor, selection.focus) : -1
  const selMax = selection ? Math.max(selection.anchor, selection.focus) : -1
  const summary = selection ? summarizeDiffSelection(parsed, selection.anchor, selection.focus) : null
  const rangeLabel = summary
    ? `@${summary.filePath}#${summary.startLine === summary.endLine ? `L${summary.startLine}` : `L${summary.startLine}-L${summary.endLine}`}`
    : ''

  function submitComment() {
    if (!summary || !onInsertComment) return
    onInsertComment(formatDiffCommentForComposer(summary, commentText))
    setSelection(null)
    setCommentText('')
  }

  function startSelect(idx: number, lineFile: string | null, shiftKey: boolean) {
    if (!onInsertComment || !lineFile) return
    if (shiftKey && selection && parsed[selection.anchor]?.filePath === lineFile) {
      setSelection({ anchor: selection.anchor, focus: idx })
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    draggingRef.current = true
    setSelection({ anchor: idx, focus: idx })
  }

  function extendSelect(idx: number, lineFile: string | null) {
    if (!draggingRef.current || !selection || !lineFile) return
    const anchorLine = parsed[selection.anchor]
    if (anchorLine?.filePath !== lineFile) return
    setSelection((prev) => (prev ? { ...prev, focus: idx } : null))
  }

  const commentBoxEl = summary ? (
    <div className="diff-comment-box">
      <div className="diff-comment-head">
        <span className="mono-chip">{rangeLabel}</span>
        <span className="diff-comment-hint">共选中 {summary.codeLines.length} 行</span>
        <button
          type="button"
          className="icon-btn"
          title="取消批注 (Esc)"
          aria-label="取消批注"
          onClick={() => {
            setSelection(null)
            setCommentText('')
          }}
        >
          <X size={12} />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="text-input diff-comment-input"
        rows={2}
        placeholder="输入针对所选代码行的修改意见（留空则仅引用代码段；Ctrl+Enter 回贴）…"
        value={commentText}
        onChange={(e) => setCommentText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setSelection(null)
            setCommentText('')
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            submitComment()
          }
        }}
      />
      <div className="diff-comment-actions">
        <button
          type="button"
          className="btn-small"
          onClick={() => {
            setSelection(null)
            setCommentText('')
          }}
        >
          取消
        </button>
        <button type="button" className="btn-primary" onClick={submitComment}>
          {commentText.trim() ? '带批注回贴输入框' : '引用代码段到输入框'}
        </button>
      </div>
    </div>
  ) : null

  if (viewMode === 'split') {
    const renderCell = (cell: SideBySideCell | null, side: 'left' | 'right') => {
      if (!cell) {
        return <div className={`diff-split-cell is-empty diff-split-${side}`} />
      }
      const selectable = Boolean(onInsertComment && cell.filePath)
      const isSelected =
        selection !== null &&
        cell.parsedIndex >= selMin &&
        cell.parsedIndex <= selMax &&
        cell.filePath === summary?.filePath &&
        selectable
      return (
        <div
          className={`diff-split-cell diff-split-${side} ${cell.kind}${isSelected ? ' is-selected' : ''}`}
          onPointerEnter={() => extendSelect(cell.parsedIndex, cell.filePath)}
        >
          <button
            type="button"
            className={`diff-split-ln${selectable ? ' is-selectable' : ''}`}
            disabled={!selectable}
            title={selectable ? '点击选择行添加修改批注（支持 Shift 多选）' : undefined}
            onPointerDown={(e) => {
              if (!selectable || e.button !== 0) return
              e.preventDefault()
              startSelect(cell.parsedIndex, cell.filePath, e.shiftKey)
            }}
            onClick={() => {
              if (selectable) requestAnimationFrame(() => textareaRef.current?.focus())
            }}
          >
            {cell.lineNum ?? ''}
          </button>
          <span className="diff-code">{cell.text || ' '}</span>
        </div>
      )
    }

    return (
      <div className="diff-lines-wrap diff-split-wrap">
        {splitRows.map((row, rowIdx) => {
          if (row.type !== 'pair') {
            return (
              <div key={`m-${row.parsedIndex}`} className={`diff-line ${row.type}`}>
                <span className="diff-code-meta">{row.raw || ' '}</span>
              </div>
            )
          }
          const showHere =
            Boolean(selection && summary) &&
            (row.left?.parsedIndex === selMax || row.right?.parsedIndex === selMax)
          return (
            <Fragment key={`p-${rowIdx}-${row.left?.parsedIndex ?? 'n'}-${row.right?.parsedIndex ?? 'n'}`}>
              <div className="diff-split-row">
                {renderCell(row.left, 'left')}
                {renderCell(row.right, 'right')}
              </div>
              {showHere && commentBoxEl}
            </Fragment>
          )
        })}
      </div>
    )
  }

  return (
    <div className="diff-lines-wrap">
      {parsed.map((line, i) => {
        const selectable = Boolean(
          onInsertComment &&
            line.filePath &&
            (line.kind === 'context' || line.kind === 'add' || line.kind === 'del'),
        )
        const isSelected =
          selection !== null &&
          i >= selMin &&
          i <= selMax &&
          line.filePath === summary?.filePath &&
          selectable
        const cls = `diff-line ${line.kind}${isSelected ? ' is-selected' : ''}`
        const showCommentBox = Boolean(selection && summary && i === selMax)

        return (
          <Fragment key={line.index}>
            <div
              className={cls}
              onPointerEnter={() => {
                if (!selectable) return
                extendSelect(i, line.filePath)
              }}
            >
              {line.kind === 'meta' || line.kind === 'hunk' ? (
                <span className="diff-code-meta">{line.raw || ' '}</span>
              ) : (
                <>
                  <button
                    type="button"
                    className={`diff-gutter${selectable ? ' is-selectable' : ''}`}
                    disabled={!selectable}
                    title={selectable ? '点击或拖拽选择行区间并添加修改批注（支持 Shift 多选）' : undefined}
                    onPointerDown={(e) => {
                      if (!selectable || e.button !== 0) return
                      e.preventDefault()
                      startSelect(i, line.filePath, e.shiftKey)
                    }}
                    onClick={() => {
                      if (!selectable) return
                      requestAnimationFrame(() => textareaRef.current?.focus())
                    }}
                  >
                    <span className="diff-ln">{line.oldLine ?? ''}</span>
                    <span className="diff-ln">{line.newLine ?? ''}</span>
                    {selectable && <span className="diff-add-comment" aria-hidden="true">+</span>}
                  </button>
                  <span className="diff-code">{line.raw || ' '}</span>
                </>
              )}
            </div>
            {showCommentBox && commentBoxEl}
          </Fragment>
        )
      })}
    </div>
  )
}

export function DiffPanel({
  cwd,
  repoRoot,
  status,
  linkedPr,
  activeHarness,
  activeTab,
  selectedTurn,
  onShowWorkingDiff,
  browser,
  terminalDocked,
  onDockTerminal,
  onTabChange,
  onRefresh,
  onRefreshPr,
  onClose,
  onCreateWorktreeThread,
  onNewThreadInWorktree,
  onRemoveWorktree,
  onReferenceFile,
  onInsertDiffComment,
}: {
  cwd: string
  repoRoot?: string
  status: GitStatusSummary | null
  linkedPr?: LinkedPullRequest | null
  activeHarness?: HarnessId
  activeTab: WorkspacePanelTab
  selectedTurn: { threadId: string; summaryId: string } | null
  onShowWorkingDiff: () => void
  browser: ReactNode
  terminalDocked: boolean
  onDockTerminal: () => void
  onTabChange: (tab: WorkspacePanelTab) => void
  onRefresh: () => void
  onRefreshPr?: () => void
  onClose: () => void
  onCreateWorktreeThread: (branchName: string, baseRef?: string) => Promise<void>
  onNewThreadInWorktree: (worktreePath: string, branch: string | null) => Promise<void>
  onRemoveWorktree: (worktreePath: string) => Promise<void>
  onReferenceFile?: (relPath: string) => void
  onInsertDiffComment?: (formatted: string) => void
}) {
  const [selected, setSelected] = useState<GitFileChange | null>(null)
  const [diffText, setDiffText] = useState('')
  const [commitMsg, setCommitMsg] = useState('')
  const [branchInput, setBranchInput] = useState('')
  const [baseRefInput, setBaseRefInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [generatingMsg, setGeneratingMsg] = useState(false)
  const [showPrForm, setShowPrForm] = useState(false)
  const [prTitle, setPrTitle] = useState('')
  const [prBase, setPrBase] = useState('')
  const [prDraft, setPrDraft] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified')
  const diffReqIdRef = useRef(0)
  const [turnDiff, setTurnDiff] = useState<{ id: string; text: string | null } | null>(null)

  useEffect(() => {
    if (!selectedTurn) return
    let cancelled = false
    void window.agentui.getThreadTurnDiff(selectedTurn.threadId, selectedTurn.summaryId)
      .catch(() => null)
      .then((text) => { if (!cancelled) setTurnDiff({ id: selectedTurn.summaryId, text }) })
    return () => { cancelled = true }
  }, [selectedTurn])

  useEffect(() => {
    diffReqIdRef.current += 1
    setSelected(null)
    setDiffText('')
    setNotice(null)
    setError(null)
    setShowPrForm(false)
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

  async function runAction(fn: () => Promise<void>, successNote?: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (successNote) setNotice(successNote)
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleGenerateCommitMessage() {
    if (!cwd || generatingMsg || busy) return
    setGeneratingMsg(true)
    setError(null)
    setNotice(null)
    try {
      const res = await window.agentui.gitGenerateCommitMessage(cwd, activeHarness)
      setCommitMsg(res.message)
      setNotice(res.source === 'ai' ? 'AI 已生成提交信息' : (res.note ?? '已根据暂存变更生成摘要'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGeneratingMsg(false)
    }
  }

  async function handlePush() {
    await runAction(async () => {
      const res = await window.agentui.gitPush(cwd)
      setNotice(
        res.setUpstream
          ? `已发布分支并设置上游 ${res.remote}/${res.branch}`
          : `已推送至 ${res.remote}/${res.branch}`,
      )
      onRefreshPr?.()
    })
  }

  async function handleCreatePr() {
    await runAction(async () => {
      const res = await window.agentui.gitCreatePr({
        cwd,
        title: prTitle.trim() || undefined,
        baseBranch: prBase.trim() || undefined,
        draft: prDraft,
      })
      setShowPrForm(false)
      setPrTitle('')
      setPrBase('')
      setPrDraft(false)
      setNotice(
        res.mode === 'gh'
          ? `PR ${res.number ? `#${res.number} ` : ''}已创建并在浏览器中打开`
          : (res.note ?? '已在浏览器中打开创建 PR 页面'),
      )
      onRefreshPr?.()
    })
  }

  const stagedCount = status?.changes.filter((c) => c.staged).length ?? 0
  const showingTurn = activeTab === 'changes' && selectedTurn !== null
  const hasRemote = Boolean(status?.remoteUrl)
  const canPush = Boolean(status?.isRepo && hasRemote && status.branch && !status.branch.startsWith('HEAD'))

  return (
    <aside className="diff-panel">
      <div className="panel-tabs">
        <div className="tab-group" role="group" aria-label="工作区面板标签">
          {WORKSPACE_TABS.map(([tab, label]) => (
            <button key={tab} type="button" className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              aria-pressed={activeTab === tab} onClick={() => onTabChange(tab)}>{label}</button>
          ))}
        </div>
        <div className="panel-tab-actions">
          {activeTab === 'terminal' && !terminalDocked && (
            <button type="button" className="icon-btn" title="终端停靠底部" aria-label="终端停靠底部" onClick={onDockTerminal}>
              <PanelBottom size={14} />
            </button>
          )}
          {(activeTab === 'changes' || activeTab === 'worktrees') && cwd && (
            <button type="button" className="icon-btn" title="刷新 Git 状态" aria-label="刷新 Git 状态" onClick={() => { onRefresh(); onRefreshPr?.() }}>
              <RefreshCw size={13} />
            </button>
          )}
          <button type="button" className="icon-btn" title="收起工作区面板" aria-label="收起工作区面板" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {error && <div className="msg-notice error" style={{ margin: '8px 10px 0' }}>{error}</div>}
      {notice && <div className="msg-notice info" style={{ margin: '8px 10px 0' }}>{notice}</div>}

      {showingTurn ? (
        <>
          <div className="turn-diff-header">
            <span>回合变更（点击行号可批注回贴）</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                className="btn-small"
                aria-pressed={diffViewMode === 'split'}
                title={diffViewMode === 'split' ? '切换为单栏 Diff' : '切换为并排对比 Diff'}
                onClick={() => setDiffViewMode((m) => (m === 'unified' ? 'split' : 'unified'))}
              >
                {diffViewMode === 'split' ? <AlignJustify size={12} /> : <Columns2 size={12} />}
                {diffViewMode === 'split' ? '单栏' : '并排'}
              </button>
              <button type="button" className="btn-small" onClick={onShowWorkingDiff}>查看当前工作区</button>
            </div>
          </div>
          {turnDiff?.id !== selectedTurn.summaryId ? <p className="panel-placeholder">正在读取本回合的差异…</p>
            : turnDiff.text ? (
              <div className="diff-viewer" key={turnDiff.id}>
                <DiffLines diffText={turnDiff.text} viewMode={diffViewMode} onInsertComment={onInsertDiffComment} />
              </div>
            )
            : <p className="panel-placeholder">本回合的差异预览已不可用。</p>}
        </>
      ) : (activeTab === 'changes' || activeTab === 'worktrees') && (!status?.isRepo ? (
        <div style={{ padding: 18, color: 'var(--text-muted)' }}>
          {!cwd ? '请选择一个项目。' : status ? '当前目录不是 Git 仓库。' : '正在读取 Git 状态…'}
        </div>
      ) : activeTab === 'changes' ? (
        <>
          <div className="git-delivery-bar">
            <div className="git-delivery-branch">
              <GitBranch size={13} />
              <span className="git-branch-name" title={status.branch ?? ''}>{status.branch ?? '(detached)'}</span>
              {status.ahead > 0 && <span className="mono-chip" title="领先远程提交数">↑{status.ahead}</span>}
              {status.behind > 0 && <span className="mono-chip" title="落后远程提交数">↓{status.behind}</span>}
              {!status.hasUpstream && hasRemote && <span className="mono-chip" title="首次推送将自动设置上游分支">未关联上游</span>}
            </div>
            <div className="git-delivery-actions">
              {canPush && (
                <button
                  type="button"
                  className="btn-small"
                  disabled={busy}
                  title={status.hasUpstream ? '推送当前分支到远程' : '首次推送并设置上游分支 (-u)'}
                  onClick={() => void handlePush()}
                >
                  <Upload size={12} />
                  {status.hasUpstream ? '推送' : '发布分支'}
                </button>
              )}
              {linkedPr ? (
                <a
                  className={`btn-small pr-link-chip pr-state-${linkedPr.state.toLowerCase()}`}
                  href={linkedPr.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`${linkedPr.title} (${linkedPr.state})`}
                >
                  <GitPullRequest size={12} />
                  PR #{linkedPr.number}
                  <ExternalLink size={11} />
                </a>
              ) : canPush ? (
                <button
                  type="button"
                  className="btn-small"
                  disabled={busy}
                  title={status.ghAvailable ? '使用 gh CLI 创建 Pull Request' : '推送后在浏览器打开创建 PR 页面'}
                  onClick={() => {
                    setPrTitle((prev) => prev || commitMsg.trim())
                    setShowPrForm((v) => !v)
                  }}
                >
                  <GitPullRequest size={12} />
                  创建 PR
                </button>
              ) : null}
            </div>
          </div>

          {showPrForm && (
            <div className="pr-create-card">
              <div className="pr-create-row">
                <input
                  type="text"
                  className="text-input"
                  placeholder="PR 标题（留空默认取最新提交标题）"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                />
              </div>
              <div className="pr-create-row">
                <input
                  type="text"
                  className="text-input"
                  placeholder="目标基线分支（可选，如 main）"
                  value={prBase}
                  onChange={(e) => setPrBase(e.target.value)}
                />
                {status.ghAvailable && (
                  <label className="pr-draft-toggle">
                    <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} />
                    <span>Draft</span>
                  </label>
                )}
              </div>
              <div className="pr-create-footer">
                <span className="pr-create-hint">
                  {status.ghAvailable ? '将先推送未同步提交并通过 gh 创建 PR' : '未检测到 gh CLI：将先推送并在浏览器打开对比页'}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn-small" disabled={busy} onClick={() => setShowPrForm(false)}>
                    取消
                  </button>
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => void handleCreatePr()}>
                    <GitPullRequest size={12} />
                    {busy ? '处理中…' : '确认创建'}
                  </button>
                </div>
              </div>
            </div>
          )}

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

          <div className="diff-viewer-bar">
            <span className="diff-viewer-file" title={selected?.path ?? ''}>
              {selected ? selected.path : '变更差异'}
            </span>
            <div className="diff-viewer-bar-actions">
              {selected && cwd && (
                <button
                  type="button"
                  className="btn-small"
                  title="在外部编辑器（VS Code / Cursor / 资源管理器）中打开此文件"
                  onClick={() => {
                    setError(null)
                    void window.agentui.openInExternalEditor(cwd, selected.path).catch((err) => {
                      setError(err instanceof Error ? err.message : String(err))
                    })
                  }}
                >
                  <Code2 size={12} /> 外部打开
                </button>
              )}
              <button
                type="button"
                className="btn-small"
                aria-pressed={diffViewMode === 'split'}
                title={diffViewMode === 'split' ? '切换为单栏统一 Diff' : '切换为左右并排 Diff'}
                onClick={() => setDiffViewMode((m) => (m === 'unified' ? 'split' : 'unified'))}
              >
                {diffViewMode === 'split' ? <AlignJustify size={12} /> : <Columns2 size={12} />}
                {diffViewMode === 'split' ? '单栏' : '并排'}
              </button>
            </div>
          </div>

          <div className="diff-viewer">
            <DiffLines
              diffText={diffText}
              filePath={selected?.path ?? null}
              viewMode={diffViewMode}
              onInsertComment={onInsertDiffComment}
            />
          </div>

          <div className="commit-box commit-box-delivery">
            <div className="commit-input-row">
              <input
                type="text"
                className="text-input"
                placeholder={stagedCount > 0 ? `提交已暂存的 ${stagedCount} 个文件...` : '请先点击 + 暂存文件后再提交'}
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
              />
              <button
                type="button"
                className="btn-small"
                title="根据已暂存 Diff 生成 Conventional Commits 提交信息"
                disabled={busy || generatingMsg || stagedCount === 0}
                onClick={() => void handleGenerateCommitMessage()}
              >
                {generatingMsg ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
                AI 生成
              </button>
            </div>
            <div className="commit-action-row">
              <button
                type="button"
                className="btn-primary"
                disabled={busy || stagedCount === 0 || !commitMsg.trim()}
                onClick={() =>
                  void runAction(async () => {
                    await window.agentui.gitCommit(cwd, commitMsg)
                    setCommitMsg('')
                  }, '提交成功')
                }
              >
                <Check size={13} />
                提交
              </button>
              {canPush && (
                <button
                  type="button"
                  className="btn-small"
                  disabled={busy || stagedCount === 0 || !commitMsg.trim()}
                  title="提交已暂存更改并立即推送到远程分支"
                  onClick={() =>
                    void runAction(async () => {
                      await window.agentui.gitCommit(cwd, commitMsg)
                      setCommitMsg('')
                      const res = await window.agentui.gitPush(cwd)
                      setNotice(`已提交并推送至 ${res.remote}/${res.branch}`)
                      onRefreshPr?.()
                    })
                  }
                >
                  <Upload size={12} />
                  提交并推送
                </button>
              )}
            </div>
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
                        <span className="harness-tag tag-pi" style={{ fontSize: 12 }}>
                          当前
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 12,
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
      ))}

      <div className="ws-panel-slot" hidden={activeTab !== 'files'}>
        {cwd ? <WorkspaceFilesPanel cwd={cwd} onReferenceFile={onReferenceFile} /> : <p className="panel-placeholder">请选择一个项目。</p>}
      </div>
      <div className="ws-panel-slot" hidden={activeTab !== 'browser'}>{browser}</div>
    </aside>
  )
}
