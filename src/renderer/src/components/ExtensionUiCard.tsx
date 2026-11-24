import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Plus, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { ExtensionUiRequest, ExtensionUiResponse } from '@shared/types'
import {
  pickSelectOption,
  TRUST_PRESET_LABELS,
  type PermissionRuleTarget,
} from '@shared/tool-policy'

const PERSISTENT_OPTION = /always|永久|始终|总是|don.?t ask|\ball\b/i

export function ExtensionUiCard({
  request,
  queueLength = 1,
  onRespond,
  onAllowAndRemember,
}: {
  request: ExtensionUiRequest
  queueLength?: number
  onRespond: (resp: ExtensionUiResponse) => Promise<void>
  onAllowAndRemember?: (
    scope: 'session' | 'project',
    rule: { target: PermissionRuleTarget; pattern: string },
    allowResponse: ExtensionUiResponse,
  ) => Promise<void>
}) {
  const [text, setText] = useState(request.prefill ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isHighRisk = request.risk?.level === 'high'
  const command = request.risk?.command ?? request.command
  const cardRef = useRef<HTMLElement>(null)
  const titleId = `approval-title-${request.id}`

  // Move focus to the safest control so keyboard users can act without hunting for the card.
  useEffect(() => {
    const root = cardRef.current
    if (!root) return
    const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? root
    target.focus()
  }, [request.id])

  async function respond(response: ExtensionUiResponse) {
    setBusy(true)
    setError(null)
    try {
      await onRespond(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const allowOnceResponse: ExtensionUiResponse | null =
    request.method === 'confirm'
      ? { id: request.id, confirmed: true }
      : request.method === 'select'
        ? (() => {
            const picked = pickSelectOption(request.options ?? [], true)
            return picked ? { id: request.id, value: picked } : null
          })()
        : null
  const canRemember = Boolean(!isHighRisk && request.suggestedRule && allowOnceResponse && onAllowAndRemember)

  async function rememberAndAllow(scope: 'session' | 'project') {
    if (!request.suggestedRule || !allowOnceResponse || !onAllowAndRemember) return
    setBusy(true)
    setError(null)
    try {
      await onAllowAndRemember(scope, request.suggestedRule, allowOnceResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section ref={cardRef} tabIndex={-1} role="alertdialog" aria-labelledby={titleId}
      className={`approval-card${isHighRisk ? ' high-risk' : ''}`}>
      <div className="approval-heading">
        <h3 id={titleId} className="approval-title">
          {isHighRisk ? <ShieldAlert size={17} className="approval-icon-danger" /> : <AlertCircle size={17} className="approval-icon-warning" />}
          <span>{request.title}</span>
        </h3>
        <div className="approval-meta">
          {request.policyPreset && (
            <span className="mono-chip" title="当前项目的工具权限预设">
              {TRUST_PRESET_LABELS[request.policyPreset]}
            </span>
          )}
          {queueLength > 1 && (
            <span className="queue-badge">还有 {queueLength - 1} 条待确认</span>
          )}
        </div>
      </div>
      {isHighRisk && (
        <div className="approval-risk">
          <strong>高风险操作</strong>
          {(request.risk?.reasons.length ?? 0) > 0 && <ul>
            {request.risk?.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>}
        </div>
      )}
      {command && <pre className="approval-command">{command}</pre>}
      {request.message && request.message.trim() !== command?.trim() && (
        command ? <details className="approval-details"><summary>请求详情</summary><p>{request.message}</p></details>
          : <p className="approval-message">{request.message}</p>
      )}
      {error && <p className="msg-notice error" role="alert">{error}</p>}

      {request.method === 'select' && (
        <div className="approval-options" role="group" aria-label="可选操作">
          {(request.options ?? []).map((opt) => {
            const persistent = PERSISTENT_OPTION.test(opt)
            return (
              <button
                key={opt}
                type="button"
                className={`btn-small approval-option${persistent ? ' is-persistent' : ''}`}
                title={persistent ? '该选项会持续授权，请谨慎选择' : undefined}
                disabled={busy}
                onClick={() => void respond({ id: request.id, value: opt })}
              >
                {opt}
                {persistent && <small>持续授权</small>}
              </button>
            )
          })}
        </div>
      )}

      {(request.method === 'input' || request.method === 'editor') && (
        <textarea
          className="text-input"
          rows={request.method === 'editor' ? 7 : 2}
          placeholder={request.placeholder ?? '请输入内容...'}
          value={text}
          data-autofocus
          onChange={(e) => setText(e.target.value)}
        />
      )}

      {canRemember && request.suggestedRule && (
        <div className="approval-remember-bar">
          <button
            type="button"
            className="btn-small"
            disabled={busy}
            title={`仅在当前会话记住允许 ${request.suggestedRule.pattern}（高风险命令仍会强制询问）`}
            onClick={() => void rememberAndAllow('session')}
          >
            <ShieldCheck size={12} />
            本会话允许 <code>{request.suggestedRule.pattern}</code>
          </button>
          <button
            type="button"
            className="btn-small"
            disabled={busy}
            title={`将 ${request.suggestedRule.pattern} 写入此项目的长期允许规则（可在设置 → 项目与权限管理）`}
            onClick={() => void rememberAndAllow('project')}
          >
            <Plus size={12} />
            加入项目允许规则
          </button>
        </div>
      )}

      <div className="approval-actions">
        {request.method === 'confirm' ? (
          <>
            <button
              type="button"
              className="btn-small"
              data-autofocus
              disabled={busy}
              onClick={() => void respond({ id: request.id, confirmed: false })}
            >
              拒绝
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void respond({ id: request.id, confirmed: true })}
            >
              允许
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn-small"
            data-autofocus={request.method === 'select' ? true : undefined}
            disabled={busy}
            onClick={() => void respond({ id: request.id, cancelled: true })}
          >
            取消
          </button>
        )}
        {(request.method === 'input' || request.method === 'editor') && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void respond({ id: request.id, value: text })}
          >
            提交
          </button>
        )}
      </div>
    </section>
  )
}
