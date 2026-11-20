import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId, type HarnessStatus } from '@shared/types'

export function SettingsModal({
  harnesses,
  customPaths,
  onSavePath,
  onRefresh,
  onClose,
}: {
  harnesses: Record<HarnessId, HarnessStatus>
  customPaths: Partial<Record<HarnessId, string>>
  onSavePath: (harness: HarnessId, path: string | null) => Promise<void>
  onRefresh: () => Promise<void>
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState<Partial<Record<HarnessId, string>>>(customPaths)
  const [saving, setSaving] = useState(false)

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-header">
          <h3>CLI 引擎探测与自定义路径</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn-small" onClick={() => void onRefresh()}>
              <RefreshCw size={12} />
              全部重新探测
            </button>
            <button type="button" className="icon-btn" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>

        {HARNESS_IDS.map((id) => {
          const st = harnesses[id]
          return (
            <div
              key={id}
              style={{
                padding: 12,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-root)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                  <span className={`dot ${st.ready ? 'dot-ready' : 'dot-missing'}`} />
                  {HARNESS_LABELS[id]}
                  {st.version ? ` v${st.version}` : ''}
                  {st.implementation ? ` (${st.implementation})` : ''}
                </span>
                <span style={{ fontSize: 11, color: st.ready ? 'var(--success)' : 'var(--danger)' }}>
                  {st.ready ? '可用' : '不可用'}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                可执行文件: {st.path ?? '未发现'}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                会话目录: {st.sessionRoot}
              </div>
              {st.error && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{st.error}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input
                  type="text"
                  className="text-input"
                  placeholder="可选：手动覆盖可执行文件绝对路径"
                  value={drafts[id] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [id]: e.target.value }))}
                />
                <button
                  type="button"
                  className="btn-small"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true)
                    try {
                      await onSavePath(id, drafts[id]?.trim() || null)
                    } finally {
                      setSaving(false)
                    }
                  }}
                >
                  应用
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
