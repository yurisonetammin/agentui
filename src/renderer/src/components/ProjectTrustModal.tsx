import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { ProjectEntry } from '@shared/types'
import {
  TRUST_PRESETS,
  TRUST_PRESET_DESCRIPTIONS,
  TRUST_PRESET_LABELS,
  type TrustPreset,
} from '@shared/tool-policy'

export function ProjectTrustModal({
  project,
  onSave,
  onClose,
}: {
  project: ProjectEntry
  onSave: (preset: TrustPreset) => void
  onClose: () => void
}) {
  const [preset, setPreset] = useState<TrustPreset>(project.trustPreset ?? 'approval')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={17} color="#34d399" />
            <span>项目信任与工具权限</span>
          </h3>
          <span className="mono-chip" style={{ maxWidth: 220 }} title={project.path}>
            {project.name}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TRUST_PRESETS.map((p) => (
            <label
              key={p}
              className={`trust-option ${preset === p ? 'active' : ''}`}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '10px 12px',
                border: `1px solid ${preset === p ? 'var(--accent, #4f8cff)' : 'var(--border)'}`,
                borderRadius: 8,
                cursor: 'pointer',
                background: preset === p ? 'rgba(79, 140, 255, 0.08)' : 'transparent',
              }}
            >
              <input
                type="radio"
                name="trust-preset"
                checked={preset === p}
                onChange={() => setPreset(p)}
                style={{ marginTop: 3 }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{TRUST_PRESET_LABELS[p]}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5 }}>
                  {TRUST_PRESET_DESCRIPTIONS[p]}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ color: 'var(--text-muted)', fontSize: 11.5, lineHeight: 1.6 }}>
          高风险命令（如 rm -rf、git push --force、git reset --hard、格式化磁盘等）在任何预设下都会弹窗要求人工确认。
          策略在引擎发起审批请求时生效；若引擎自身配置为静默自动执行、不发起审批，则无法在此拦截。
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn-small" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={() => onSave(preset)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}