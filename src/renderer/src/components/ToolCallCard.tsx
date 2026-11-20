import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from 'lucide-react'
import type { ToolCallItem } from '@shared/types'

function summarizeArgs(tool: ToolCallItem): string {
  const args = tool.args
  if (args) {
    for (const key of ['path', 'file_path', 'command', 'cmd', 'pattern', 'query']) {
      const val = args[key]
      if (typeof val === 'string' && val.trim()) return val.trim()
    }
  }
  if (tool.argsText) {
    return tool.argsText.replace(/\s+/g, ' ').slice(0, 90)
  }
  return ''
}

export function ToolCallCard({ tool }: { tool: ToolCallItem }) {
  const [open, setOpen] = useState(tool.status === 'error')
  const summary = summarizeArgs(tool)

  return (
    <div className="tool-card">
      <button type="button" className="tool-header" onClick={() => setOpen((v) => !v)}>
        <span className="tool-header-left">
          {tool.status === 'running' ? (
            <Loader2 size={14} className="spin" color="#5b8cff" />
          ) : tool.status === 'error' ? (
            <XCircle size={14} color="#f87171" />
          ) : (
            <CheckCircle2 size={14} color="#34d399" />
          )}
          <Wrench size={12} color="#68768f" />
          <span className="tool-name">{tool.name}</span>
          {summary && <span className="tool-summary">{summary}</span>}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#68768f', fontSize: 11 }}>
          {tool.durationMs !== undefined && <span>{tool.durationMs}ms</span>}
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {tool.argsText && (
            <div>
              <div style={{ fontSize: 11, color: '#68768f', marginBottom: 4 }}>参数</div>
              <pre className="tool-pre">{tool.argsText}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div style={{ fontSize: 11, color: tool.isError ? '#f87171' : '#68768f', marginBottom: 4 }}>
                {tool.isError ? '错误输出' : '执行结果'}
              </div>
              <pre className="tool-pre">{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
