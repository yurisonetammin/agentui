import { useEffect, useMemo, useState } from 'react'
import { Columns2, CopyPlus, GitFork, RefreshCw, X } from 'lucide-react'
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  type HarnessId,
  type SessionTreeSnapshot,
  type ThreadEntry,
  type TimelineItem,
} from '@shared/types'
import { MarkdownView } from './MarkdownView'

function getRootThreadId(thread: ThreadEntry, byId: Map<string, ThreadEntry>): string {
  const visited = new Set<string>()
  let cur: ThreadEntry = thread
  while (cur.parentThreadId && !visited.has(cur.id)) {
    visited.add(cur.id)
    const parent = byId.get(cur.parentThreadId)
    if (!parent) break
    cur = parent
  }
  return cur.id
}

function summarizeBranch(items: TimelineItem[]) {
  let lastUser = ''
  let lastAssistantText = ''
  let model: string | undefined
  let toolCount = 0
  let totalTokens = 0
  let totalCost = 0

  for (const item of items) {
    if (item.role === 'user') {
      lastUser = item.text
    } else if (item.role === 'assistant') {
      toolCount += Object.keys(item.toolCalls).length
      if (item.model) model = item.model
      if (item.usage) {
        totalTokens += item.usage.totalTokens
        totalCost += item.usage.costTotal ?? 0
      }
      const textParts = item.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n')
        .trim()
      if (textParts) lastAssistantText = textParts
    }
  }

  return { lastUser, lastAssistantText, model, toolCount, totalTokens, totalCost }
}

export function ForkTreeModal({
  activeThread,
  allThreads,
  timelines,
  tree,
  loading,
  initialTab = 'tree',
  highlightText = null,
  onFork,
  onSelectThread,
  onLoadTimeline,
  onRefresh,
  onClose,
}: {
  activeThread: ThreadEntry
  allThreads: ThreadEntry[]
  timelines: Record<string, TimelineItem[]>
  tree: SessionTreeSnapshot | null
  loading: boolean
  initialTab?: 'tree' | 'compare'
  highlightText?: string | null
  onFork: (input: { entryId?: string | null; mode: 'new-thread' | 'in-place'; harness?: HarnessId }) => Promise<void>
  onSelectThread: (threadId: string) => void
  onLoadTimeline: (threadId: string) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'tree' | 'compare'>(initialTab)
  const [targetHarness, setTargetHarness] = useState<HarnessId>(activeThread.harness)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const branchFamily = useMemo(() => {
    const byId = new Map(allThreads.map((t) => [t.id, t]))
    const rootId = getRootThreadId(activeThread, byId)
    return allThreads
      .filter((t) => getRootThreadId(t, byId) === rootId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }, [activeThread, allThreads])

  useEffect(() => {
    if (tab !== 'compare') return
    for (const branch of branchFamily) {
      if (!timelines[branch.id]) {
        onLoadTimeline(branch.id)
      }
    }
  }, [tab, branchFamily, timelines, onLoadTimeline])

  async function runFork(key: string, input: { entryId?: string | null; mode: 'new-thread' | 'in-place' }) {
    setBusyKey(key)
    setError(null)
    try {
      await onFork({ ...input, harness: targetHarness })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <GitFork size={16} color="var(--accent)" />
              <span>会话分叉树与多方案对比</span>
            </h3>
            <div className="tab-group">
              <button
                type="button"
                className={`tab-btn ${tab === 'tree' ? 'active' : ''}`}
                onClick={() => setTab('tree')}
              >
                <GitFork size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                分叉节点 ({tree?.messages.length ?? 0})
              </button>
              <button
                type="button"
                className={`tab-btn ${tab === 'compare' ? 'active' : ''}`}
                onClick={() => setTab('compare')}
              >
                <Columns2 size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                并行对比 ({branchFamily.length})
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button type="button" className="icon-btn" title="刷新会话树" onClick={onRefresh}>
              <RefreshCw size={14} className={loading ? 'spin' : undefined} />
            </button>
            <button type="button" className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>

        {error && <div className="msg-notice error">{error}</div>}

        {tab === 'tree' ? (
          <>
            <div className="fork-toolbar">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>新分支使用引擎：</span>
                <select
                  className="select-pill"
                  value={targetHarness}
                  onChange={(e) => setTargetHarness(e.target.value as HarnessId)}
                >
                  {HARNESS_IDS.map((id) => (
                    <option key={id} value={id}>
                      {HARNESS_LABELS[id]} {id === activeThread.harness ? '(当前)' : ''}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                  从任意历史提问分叉出独立会话，保留原对话便于一题多解对比。
                </span>
              </div>
              <button
                type="button"
                className="btn-small"
                disabled={busyKey !== null || !tree?.sessionPath}
                onClick={() => void runFork('clone-leaf', { entryId: null, mode: 'new-thread' })}
              >
                <CopyPlus size={12} />
                克隆当前完整分支
              </button>
            </div>

            <div className="fork-tree-list">
              {loading && (!tree || tree.messages.length === 0) ? (
                <div className="autocomplete-empty">正在读取会话节点树...</div>
              ) : !tree || tree.messages.length === 0 ? (
                <div className="autocomplete-empty">
                  当前会话暂无可分叉的历史节点（请先完成至少一轮对话生成 `.jsonl` 记录）。
                </div>
              ) : (
                tree.messages.map((msg, idx) => {
                  const isHighlighted = Boolean(highlightText && msg.text.trim() === highlightText.trim())
                  return (
                    <div
                      key={msg.entryId}
                      className={`fork-node-card ${isHighlighted ? 'highlighted' : ''}`}
                    >
                      <div className="fork-node-rail">
                        <span className="fork-turn-badge">#{idx + 1}</span>
                        {idx < tree.messages.length - 1 && <span className="fork-rail-line" />}
                      </div>
                      <div className="fork-node-body">
                        <div className="fork-node-prompt">{msg.text}</div>
                        {msg.assistantPreview && (
                          <div className="fork-node-reply">
                            {msg.model && <span className="mono-chip" style={{ fontSize: 12 }}>{msg.model}</span>}
                            <span>{msg.assistantPreview}</span>
                          </div>
                        )}
                        <div className="fork-node-actions">
                          <span className="mono-chip" style={{ fontSize: 12 }} title="Session Entry ID">
                            {msg.entryId.slice(0, 10)}
                          </span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn-small"
                              disabled={busyKey !== null}
                              title="在当前会话原地回溯并分叉（通过原生 fork/branch RPC）"
                              onClick={() => void runFork(`inplace:${msg.entryId}`, { entryId: msg.entryId, mode: 'in-place' })}
                            >
                              原地分叉
                            </button>
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={busyKey !== null}
                              title="基于此节点之前的历史新建并行分支，原会话保持不变"
                              onClick={() => void runFork(`new:${msg.entryId}`, { entryId: msg.entryId, mode: 'new-thread' })}
                            >
                              <GitFork size={12} />
                              {busyKey === `new:${msg.entryId}` ? '分叉中...' : '从此处分叉对比'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </>
        ) : (
          <div className="compare-wrap">
            {branchFamily.length <= 1 && (
              <div className="msg-notice info" style={{ marginBottom: 10 }}>
                当前对话还没有并行分叉分支。可在「分叉节点」标签页选择任意提问节点点击「从此处分叉对比」，即可在此并排对比不同思路、模型或引擎的结果。
              </div>
            )}
            <div className="compare-grid">
              {branchFamily.map((branch) => {
                const items = timelines[branch.id] ?? []
                const summary = summarizeBranch(items)
                const isCurrent = branch.id === activeThread.id
                return (
                  <div key={branch.id} className={`compare-card ${isCurrent ? 'current' : ''}`}>
                    <div className="compare-card-header">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className={`harness-tag tag-${branch.harness}`}>
                            {branch.harness === 'prime' ? 'Prime' : HARNESS_LABELS[branch.harness]}
                          </span>
                          <span className="compare-card-title" title={branch.title}>
                            {branch.title}
                          </span>
                          {isCurrent && (
                            <span className="harness-tag tag-pi" style={{ fontSize: 9.5 }}>
                              当前
                            </span>
                          )}
                        </div>
                        <div className="compare-card-meta">
                          <span>{summary.model ?? branch.modelId ?? '默认模型'}</span>
                          <span>· Tool: {summary.toolCount}</span>
                          {summary.totalTokens > 0 && (
                            <span>
                              · {summary.totalTokens.toLocaleString()} tok
                              {summary.totalCost > 0 ? ` ($${summary.totalCost.toFixed(4)})` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      {!isCurrent && (
                        <button
                          type="button"
                          className="btn-small"
                          onClick={() => {
                            onSelectThread(branch.id)
                            onClose()
                          }}
                        >
                          切换到此分支
                        </button>
                      )}
                    </div>

                    {summary.lastUser && (
                      <div className="compare-prompt-box" title={summary.lastUser}>
                        <strong>提问：</strong>
                        {summary.lastUser}
                      </div>
                    )}

                    <div className="compare-reply-box">
                      {summary.lastAssistantText ? (
                        <MarkdownView content={summary.lastAssistantText} />
                      ) : (
                        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          暂无回复内容（可切到此分支发送修订后的指令开始对比）。
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
