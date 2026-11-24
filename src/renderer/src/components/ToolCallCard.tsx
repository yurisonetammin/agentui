import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckCircle2, ChevronDown, ChevronRight, Code2, Loader2, Wrench, XCircle } from 'lucide-react'
import type { ToolCallItem } from '@shared/types'

const VIRTUAL_LINE_THRESHOLD = 400
const VIRTUAL_VIEWPORT_HEIGHT = 320
const MAX_ARGS_CHARS = 20_000
const PREVIEW_LINES = 12

function extractToolFilePath(tool: ToolCallItem): { path: string; line?: number } | null {
  const args = tool.args
  if (!args) return null
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target_file']) {
    const val = args[key]
    if (typeof val === 'string' && val.trim() && !val.includes('\n')) {
      const lineRaw = args.line ?? args.start_line ?? args.startLine ?? args.offset
      const line = typeof lineRaw === 'number' && Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : undefined
      return { path: val.trim(), line }
    }
  }
  return null
}

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
function ToolOutputView({ text, codeFontSize }: { text: string; codeFontSize: number }) {
  const lines = useMemo(() => text.split('\n'), [text])
  const lineHeight = codeFontSize * 1.5
  const [expanded, setExpanded] = useState(false)
  const parentRef = useRef<HTMLDivElement | null>(null)
  const virtualized = expanded && lines.length > VIRTUAL_LINE_THRESHOLD
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => lineHeight,
    overscan: 24,
    enabled: virtualized,
  })
  useEffect(() => { virtualizer.measure() }, [lineHeight, virtualizer])

  return (
    <div>
      {virtualized ? <div ref={parentRef} className="tool-pre-virtual" style={{ height: VIRTUAL_VIEWPORT_HEIGHT }}>
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
                height: lineHeight,
                lineHeight: `${lineHeight}px`,
              }}
            >
              {lines[vItem.index] || ' '}
            </div>
          ))}
        </div>
      </div> : <pre className="tool-pre">{expanded ? text : lines.slice(0, PREVIEW_LINES).join('\n')}</pre>}
      {lines.length > PREVIEW_LINES && (
        <button type="button" className="output-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起输出' : `展开全部 ${lines.length.toLocaleString()} 行`}
        </button>
      )}
    </div>
  )
}

const toolCardOpen = new Map<string, boolean>()

export function ToolCallCard({
  tool,
  codeFontSize,
  cwd,
}: {
  tool: ToolCallItem
  codeFontSize: number
  cwd?: string | null
}) {
  // An explicit user choice wins; otherwise errors auto-expand (also when a running tool fails later).
  const [choice, setChoice] = useState<boolean | undefined>(() => toolCardOpen.get(tool.id))
  const open = choice ?? tool.status === 'error'
  const toggle = () => {
    toolCardOpen.set(tool.id, !open)
    setChoice(!open)
  }
  const summary = summarizeArgs(tool)
  const fileTarget = cwd ? extractToolFilePath(tool) : null
  const argsText =
    tool.argsText.length > MAX_ARGS_CHARS
      ? `${tool.argsText.slice(0, MAX_ARGS_CHARS)}\n... [参数过长，已截断 ${tool.argsText.length - MAX_ARGS_CHARS} 字符]`
      : tool.argsText

  return (
    <div className="tool-card">
      <div className="tool-header-row">
        <button type="button" className="tool-header" aria-expanded={open} onClick={toggle}>
          <span className="tool-header-left">
            {tool.status === 'running' ? (
              <Loader2 size={14} className="spin" color="var(--accent)" />
            ) : tool.status === 'error' ? (
              <XCircle size={14} color="var(--danger)" />
            ) : (
              <CheckCircle2 size={14} color="var(--success)" />
            )}
            <Wrench size={12} color="var(--text-muted)" />
            <span className="tool-name">{tool.name}</span>
            {summary && <span className="tool-summary">{summary}</span>}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
            {tool.durationMs !== undefined && <span>{tool.durationMs}ms</span>}
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </button>
        {fileTarget && cwd && (
          <button
            type="button"
            className="icon-btn tool-open-external"
            title={`在外部编辑器中打开 ${fileTarget.path}${fileTarget.line ? `:${fileTarget.line}` : ''}`}
            aria-label={`在外部编辑器中打开 ${fileTarget.path}`}
            onClick={() => {
              void window.agentui.openInExternalEditor(cwd, fileTarget.path, fileTarget.line).catch(() => undefined)
            }}
          >
            <Code2 size={12} />
          </button>
        )}
      </div>
      {open && (
        <div className="tool-body">
          {argsText && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>参数</div>
              <pre className="tool-pre">{argsText}</pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div style={{ fontSize: 12, color: tool.isError ? 'var(--danger)' : 'var(--text-muted)', marginBottom: 4 }}>
                {tool.isError ? '错误输出' : '执行结果'}
              </div>
              <ToolOutputView text={tool.output} codeFontSize={codeFontSize} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
