import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from 'lucide-react'
import type { ToolCallItem } from '@shared/types'

const VIRTUAL_LINE_THRESHOLD = 400
const LINE_HEIGHT = 17
const VIRTUAL_VIEWPORT_HEIGHT = 320
const MAX_ARGS_CHARS = 20_000

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

/** Renders tool output; switches to line-based virtual scrolling for huge outputs. */
function ToolOutputView({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n'), [text])
  const parentRef = useRef<HTMLDivElement | null>(null)
  const virtualized = lines.length > VIRTUAL_LINE_THRESHOLD
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 24,
    enabled: virtualized,
  })

  if (!virtualized) {
    return <pre className="tool-pre">{text}</pre>
  }

  return (
    <div>
      <div style={{ fontSize: 10.5, color: '#68768f', marginBottom: 3 }}>
        共 {lines.length.toLocaleString()} 行 · 虚拟滚动渲染
      </div>
      <div ref={parentRef} className="tool-pre-virtual" style={{ height: VIRTUAL_VIEWPORT_HEIGHT }}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            minWidth: '100%',
            width: 'max-content',
          }}
        >
          {virtualizer.getVirtualItems().map((vItem) => (
            <div
              key={vItem.index}
              className="tool-pre-line"
              style={{
                position: 'absolute',
                top: vItem.start,
                left: 0,
                height: LINE_HEIGHT,
                lineHeight: `${LINE_HEIGHT}px`,
              }}
            >
              {lines[vItem.index] || ' '}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ToolCallCard({ tool }: { tool: ToolCallItem }) {
  const [open, setOpen] = useState(tool.status === 'error')
  const summary = summarizeArgs(tool)
  const argsText =
    tool.argsText.length > MAX_ARGS_CHARS
      ? `${tool.argsText.slice(0, MAX_ARGS_CHARS)}\n... [参数过长，已截断 ${tool.argsText.length - MAX_ARGS_CHARS} 字符]`
      : tool.argsText

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
          {argsText && (
            <div>
              <div style={{ fontSize: 11, color: '#68768f', marginBottom: 4 }}>参数</div>
              <pre className="tool-pre">{argsText}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div style={{ fontSize: 11, color: tool.isError ? '#f87171' : '#68768f', marginBottom: 4 }}>
                {tool.isError ? '错误输出' : '执行结果'}
              </div>
              <ToolOutputView text={tool.output} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}