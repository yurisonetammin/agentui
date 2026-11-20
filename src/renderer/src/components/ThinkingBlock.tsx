import { useState } from 'react'
import { Brain, ChevronDown, ChevronRight } from 'lucide-react'

export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(Boolean(streaming))
  const lines = text.split(/\r?\n/).length

  return (
    <div className="thinking-card">
      <button type="button" className="thinking-header" onClick={() => setOpen((v) => !v)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Brain size={13} color="#9aa7bd" />
          <span>{streaming ? '正在思考...' : '思考过程'}</span>
          <span style={{ color: '#68768f', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
            {lines} 行 · {text.length} 字符
          </span>
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}
