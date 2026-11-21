import { Keyboard, X } from 'lucide-react'
import type { ConversationSettings } from '@shared/settings'
import { shortcutHints } from '@shared/shortcuts'

export function ShortcutsModal({ enterWhileRunning, onClose }: {
  enterWhileRunning: ConversationSettings['enterWhileRunning']
  onClose: () => void
}) {
  const hints = shortcutHints(enterWhileRunning)
  const globalHints = hints.filter((h) => h.scope === 'global')
  const composerHints = hints.filter((h) => h.scope === 'composer')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Keyboard size={16} color="var(--accent)" />
            <span>快捷键速查</span>
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭 (Esc)">
            <X size={15} />
          </button>
        </div>

        <div className="shortcut-section">
          <div className="shortcut-section-title">全局工作台</div>
          <div className="shortcut-grid">
            {globalHints.map((hint) => (
              <div key={hint.keys.join('+')} className="shortcut-row">
                <span className="shortcut-desc">{hint.description}</span>
                <span className="shortcut-keys">
                  {hint.keys.map((k) => (
                    <kbd key={k} className="kbd-key">
                      {k}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="shortcut-section">
          <div className="shortcut-section-title">指令输入框</div>
          <div className="shortcut-grid">
            {composerHints.map((hint) => (
              <div key={hint.keys.join('+')} className="shortcut-row">
                <span className="shortcut-desc">{hint.description}</span>
                <span className="shortcut-keys">
                  {hint.keys.map((k) => (
                    <kbd key={k} className="kbd-key">
                      {k}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
