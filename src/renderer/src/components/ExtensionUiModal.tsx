import { useState } from 'react'
import { AlertCircle, ShieldAlert } from 'lucide-react'
import type { ExtensionUiRequest, ExtensionUiResponse } from '@shared/types'
import { TRUST_PRESET_LABELS } from '@shared/tool-policy'

export function ExtensionUiModal({
  request,
  threadTitle,
  harnessLabel,
  queueLength = 1,
  onRespond,
}: {
  request: ExtensionUiRequest
  threadTitle?: string
  harnessLabel?: string
  queueLength?: number
  onRespond: (resp: ExtensionUiResponse) => void
}) {
  const [text, setText] = useState(request.prefill ?? '')

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertCircle size={17} color="#fbbf24" />
            <span>{request.title}</span>
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {request.policyPreset && (
              <span className="mono-chip" title="当前项目的工具权限预设">
                {TRUST_PRESET_LABELS[request.policyPreset]}
              </span>
            )}
            {(harnessLabel || threadTitle) && (
              <span className="mono-chip" style={{ maxWidth: 210 }} title={threadTitle}>
                {[harnessLabel, threadTitle].filter(Boolean).join(' · ')}
              </span>
            )}
            {queueLength > 1 && (
              <span className="queue-badge">还有 {queueLength - 1} 条待确认</span>
            )}
          </div>
        </div>
        {request.risk?.level === 'high' && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              padding: '9px 12px',
              borderRadius: 8,
              border: '1px solid rgba(248, 113, 113, 0.55)',
              background: 'rgba(248, 113, 113, 0.10)',
              color: '#fca5a5',
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 700 }}>检测到高风险操作，请仔细核对后再确认</div>
              {request.risk.reasons.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                  {request.risk.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {request.message && (
          <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{request.message}</div>
        )}

        {request.method === 'select' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(request.options ?? []).map((opt) => (
              <button
                key={opt}
                type="button"
                className="btn-small"
                style={{ justifyContent: 'flex-start', padding: '8px 12px', fontSize: 12.5 }}
                onClick={() => onRespond({ id: request.id, value: opt })}
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {(request.method === 'input' || request.method === 'editor') && (
          <textarea
            className="text-input"
            rows={request.method === 'editor' ? 7 : 2}
            placeholder={request.placeholder ?? '请输入内容...'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            className="btn-small"
            onClick={() => onRespond({ id: request.id, cancelled: true })}
          >
            取消
          </button>
          {request.method === 'confirm' && (
            <>
              <button
                type="button"
                className="btn-small"
                onClick={() => onRespond({ id: request.id, confirmed: false })}
              >
                拒绝
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => onRespond({ id: request.id, confirmed: true })}
              >
                确认允许
              </button>
            </>
          )}
          {(request.method === 'input' || request.method === 'editor') && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => onRespond({ id: request.id, value: text })}
            >
              提交
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
