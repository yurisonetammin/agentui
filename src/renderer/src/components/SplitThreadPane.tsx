import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, ArrowUp, GitBranch, Maximize2, Square, X } from 'lucide-react'
import {
  HARNESS_LABELS,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
  type ThreadEntry,
  type TimelineItem,
} from '@shared/types'
import type { PermissionRuleTarget } from '@shared/tool-policy'
import { statusDotClass, statusLabel } from '../workbench'
import { AssistantMessage } from './AssistantMessage'
import { ExtensionUiCard } from './ExtensionUiCard'

interface SplitThreadPaneProps {
  thread: ThreadEntry
  allThreads: readonly ThreadEntry[]
  activeThreadId: string | null
  timeline: readonly TimelineItem[]
  pendingUi: readonly ExtensionUiRequest[]
  codeFontSize: number
  collapseToolGroups: boolean
  onSelectSplitThread: (threadId: string) => void
  onSwapWithPrimary: () => void
  onPromoteToPrimary: () => void
  onClose: () => void
  onSendPrompt: (threadId: string, message: string) => Promise<void>
  onAbort: (threadId: string) => Promise<void>
  onRespondUi: (threadId: string, response: ExtensionUiResponse, requestId: string) => Promise<void>
  onAllowAndRemember?: (
    threadId: string,
    scope: 'session' | 'project',
    rule: { target: PermissionRuleTarget; pattern: string },
    allowResponse: ExtensionUiResponse,
    requestId: string,
  ) => Promise<void>
}

export function SplitThreadPane({
  thread,
  allThreads,
  activeThreadId,
  timeline,
  pendingUi,
  codeFontSize,
  collapseToolGroups,
  onSelectSplitThread,
  onSwapWithPrimary,
  onPromoteToPrimary,
  onClose,
  onSendPrompt,
  onAbort,
  onRespondUi,
  onAllowAndRemember,
}: SplitThreadPaneProps) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  const activePending = pendingUi[0]
  const isStreaming =
    thread.status === 'streaming' ||
    thread.status === 'starting' ||
    thread.status === 'compacting' ||
    thread.status === 'waiting_ui' ||
    Boolean(activePending)

  useEffect(() => {
    stickRef.current = true
  }, [thread.id])

  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [timeline, thread.id, activePending?.id])

  async function submit() {
    const trimmed = draft.trim()
    if (!trimmed || sending) return
    setSending(true)
    setDraft('')
    try {
      await onSendPrompt(thread.id, trimmed)
    } catch {
      setDraft(trimmed)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="split-thread-pane" aria-label="分屏对比会话">
      <header className="split-pane-header">
        <div className="split-pane-select-wrap">
          <span className={`dot ${statusDotClass(thread.status)}`} title={statusLabel(thread.status)} />
          <select
            className="select-pill split-pane-select"
            aria-label="选择分屏会话"
            value={thread.id}
            onChange={(e) => onSelectSplitThread(e.target.value)}
          >
            {allThreads.map((t) => (
              <option key={t.id} value={t.id} disabled={t.id === activeThreadId}>
                {t.title} · {HARNESS_LABELS[t.harness]}{t.worktreeBranch ? ` (${t.worktreeBranch})` : ''}
              </option>
            ))}
          </select>
          <span className={`harness-tag tag-${thread.harness}`}>{HARNESS_LABELS[thread.harness]}</span>
          {thread.worktreeBranch && (
            <span className="mono-chip split-branch-chip" title={thread.cwd}>
              <GitBranch size={11} />
              {thread.worktreeBranch}
            </span>
          )}
        </div>
        <div className="split-pane-actions">
          <button
            type="button"
            className="icon-btn"
            title="与左侧主会话互换"
            aria-label="与左侧主会话互换"
            onClick={onSwapWithPrimary}
          >
            <ArrowLeftRight size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="切换为主会话并关闭分屏"
            aria-label="切换为主会话"
            onClick={onPromoteToPrimary}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="关闭分屏"
            aria-label="关闭分屏"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="split-pane-timeline"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {timeline.length === 0 ? (
          <div className="split-pane-empty">
            该会话暂无消息。可在下方直接发送指令，与左侧会话并行赛马对比。
          </div>
        ) : (
          timeline.map((item) => {
            if (item.role === 'user') {
              return (
                <div key={item.id} className="msg-user-wrap">
                  <div className="msg-user">{item.text}</div>
                </div>
              )
            }
            if (item.role === 'assistant') {
              return (
                <AssistantMessage
                  key={item.id}
                  item={item}
                  codeFontSize={codeFontSize}
                  collapseToolGroups={collapseToolGroups}
                  cwd={thread.cwd}
                />
              )
            }
            if (item.role === 'change-summary') {
              return (
                <div key={item.id} className="change-summary-card">
                  <span>本回合变更 {item.changes.files} 个文件</span>
                  <span className="diff-stat-add">+{item.changes.added}</span>
                  <span className="diff-stat-del">-{item.changes.removed}</span>
                </div>
              )
            }
            return (
              <div key={item.id} className={`msg-notice ${item.kind}`}>
                {item.text}
              </div>
            )
          })
        )}

        {activePending && (
          <ExtensionUiCard
            key={activePending.id}
            request={activePending}
            queueLength={pendingUi.length}
            onRespond={async (resp) => {
              await onRespondUi(activePending.threadId, resp, activePending.id)
            }}
            onAllowAndRemember={
              onAllowAndRemember
                ? async (scope, rule, allowResponse) => {
                    await onAllowAndRemember(activePending.threadId, scope, rule, allowResponse, activePending.id)
                  }
                : undefined
            }
          />
        )}
      </div>

      <div className="split-pane-composer">
        <textarea
          className="text-input split-pane-input"
          rows={2}
          placeholder={`向「${thread.title}」发送指令（Enter 发送，Shift+Enter 换行）…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <button
          type="button"
          className="send-button split-send-btn"
          disabled={!isStreaming && (!draft.trim() || sending)}
          aria-label={isStreaming ? '停止分屏会话' : '发送到分屏会话'}
          title={isStreaming ? '停止分屏会话' : '发送 (Enter)'}
          onClick={() => {
            if (isStreaming) void onAbort(thread.id)
            else void submit()
          }}
        >
          {isStreaming ? <Square size={12} fill="currentColor" /> : <ArrowUp size={16} strokeWidth={2.4} />}
        </button>
      </div>
    </section>
  )
}
