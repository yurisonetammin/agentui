import { useState } from 'react'
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from 'lucide-react'
import { extractSubagentInfo, type SubagentCallInfo } from '@shared/subagent'
import type { TimelineItem, ToolCallItem } from '@shared/types'
import { MarkdownView } from './MarkdownView'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'

function SubagentProgressCard({
  tool,
  info,
  codeFontSize,
}: {
  tool: ToolCallItem
  info: SubagentCallInfo
  codeFontSize: number
}) {
  const [open, setOpen] = useState(tool.status === 'running' || tool.status === 'error')
  const previewOutput = tool.output
    ? tool.output.length > 6_000
      ? `${tool.output.slice(0, 6_000)}\n…（已截断，共 ${tool.output.length.toLocaleString()} 字符）`
      : tool.output
    : ''

  return (
    <div className={`subagent-card is-${info.status}`}>
      <button type="button" className="subagent-header" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="subagent-header-left">
          <span className="subagent-tree-dot" aria-hidden="true" />
          {info.status === 'running' ? (
            <Loader2 size={13} className="spin" color="var(--accent)" />
          ) : info.status === 'error' ? (
            <XCircle size={13} color="var(--danger)" />
          ) : (
            <CheckCircle2 size={13} color="var(--success)" />
          )}
          <Bot size={13} color="var(--accent)" />
          <span className="subagent-role-badge">{info.role}</span>
          {info.model && <span className="mono-chip">{info.model}</span>}
          <span className="subagent-desc" title={info.description}>{info.description}</span>
        </span>
        <span className="subagent-header-right">
          <span className="subagent-status-text">
            {info.status === 'running' ? '子代理执行中' : info.status === 'error' ? '失败' : '完成'}
          </span>
          {info.durationMs !== undefined && <span>{(info.durationMs / 1000).toFixed(1)}s</span>}
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {open && (
        <div className="subagent-body" style={{ fontSize: codeFontSize }}>
          {info.prompt && (
            <div className="subagent-section">
              <div className="subagent-section-label">委派任务</div>
              <pre className="tool-pre">{info.prompt}</pre>
            </div>
          )}
          {previewOutput && (
            <div className="subagent-section">
              <div className="subagent-section-label" style={{ color: tool.isError ? 'var(--danger)' : undefined }}>
                {tool.isError ? '子代理错误' : '子代理返回'}
              </div>
              <pre className="tool-pre">{previewOutput}</pre>
            </div>
          )}
          {!info.prompt && !previewOutput && (
            <div className="subagent-section-label">等待子代理返回结果…</div>
          )}
        </div>
      )}
    </div>
  )
}

function summarizeTools(tools: ToolCallItem[]): string {
  let reads = 0
  let commands = 0
  let edits = 0
  let other = 0
  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    if (/^(read|view|cat)(?:$|[_-]|file)/.test(name)) reads += 1
    else if (/bash|shell|exec|terminal|command/.test(name)) commands += 1
    else if (/^(edit|write|patch|apply_patch|replace)/.test(name)) edits += 1
    else other += 1
  }
  return [reads && `读取 ${reads} 次文件`, commands && `运行 ${commands} 条命令`,
    edits && `编辑 ${edits} 次文件`, other && `${other} 次工具调用`].filter(Boolean).join('、')
}

/** Explicit open/closed choices, kept outside React so virtual-list unmounts don't reset them. */
const toolGroupOpen = new Map<string, boolean>()

export function AssistantMessage({ item, codeFontSize, collapseToolGroups, cwd }: {
  item: Extract<TimelineItem, { role: 'assistant' }>
  codeFontSize: number
  collapseToolGroups: boolean
  cwd?: string | null
}) {
  const groups: Array<
    | { key: string; kind: 'tools'; tools: ToolCallItem[] }
    | { key: string; kind: 'subagent'; tool: ToolCallItem; info: SubagentCallInfo }
    | { key: string; kind: 'text'; text: string; thinking: boolean }
  > = []

  item.parts.forEach((part, index) => {
    if (part.type !== 'tool') {
      groups.push({ key: `${part.type}-${index}`, kind: 'text', text: part.text, thinking: part.type === 'thinking' })
      return
    }
    const tool = item.toolCalls[part.toolCallId]
    if (!tool) return
    const subagentInfo = extractSubagentInfo(tool)
    if (subagentInfo) {
      groups.push({ key: `sub-${tool.id}`, kind: 'subagent', tool, info: subagentInfo })
      return
    }
    const last = groups[groups.length - 1]
    if (last && last.kind === 'tools') last.tools.push(tool)
    else groups.push({ key: tool.id, kind: 'tools', tools: [tool] })
  })

  return (
    <div className="msg-assistant">
      {groups.map((group, index) => {
        if (group.kind === 'text') {
          return group.thinking ? <ThinkingBlock key={group.key} text={group.text} streaming={item.streaming} />
            : <MarkdownView key={group.key} content={group.text} streaming={item.streaming && index === groups.length - 1} />
        }
        if (group.kind === 'subagent') {
          return (
            <SubagentProgressCard
              key={group.key}
              tool={group.tool}
              info={group.info}
              codeFontSize={codeFontSize}
            />
          )
        }
        const failed = group.tools.filter((tool) => tool.status === 'error').length
        const running = group.tools.some((tool) => tool.status === 'running')
        const stateKey = `${item.id}:${group.key}`
        // User choice wins (and survives virtual-list unmounts); otherwise open when
        // settings say so, or when something failed / is still running.
        const open = toolGroupOpen.get(stateKey) ?? (!collapseToolGroups || failed > 0 || running)
        return (
          <details key={group.key} className="tool-group" open={open}
            onToggle={(event) => {
              const next = event.currentTarget.open
              if (next !== open) toolGroupOpen.set(stateKey, next)
            }}>
            <summary>
              <ChevronRight size={13} className="disclosure-chevron" /><Wrench size={13} />
              <span>{summarizeTools(group.tools)}</span>
              {running && <small>执行中</small>}
              {failed > 0 && <small className="tool-group-error">{failed} 项失败</small>}
            </summary>
            <div className="tool-group-items">
              {group.tools.map((tool) => (
                <ToolCallCard key={tool.id} tool={tool} codeFontSize={codeFontSize} cwd={cwd} />
              ))}
            </div>
          </details>
        )
      })}
      {item.errorMessage && <div className="msg-notice error">{item.errorMessage}</div>}
      {item.streaming && groups.length === 0 && <span className="streaming-caret" role="status" aria-label="正在输出" />}
      {item.usage && !item.streaming && <div className="msg-meta">
        {item.usage.totalTokens.toLocaleString()} tokens{item.usage.costTotal ? ` · $${item.usage.costTotal.toFixed(4)}` : ''}
      </div>}
    </div>
  )
}
