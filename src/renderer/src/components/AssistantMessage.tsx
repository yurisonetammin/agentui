import { ChevronRight, Wrench } from 'lucide-react'
import type { TimelineItem, ToolCallItem } from '@shared/types'
import { MarkdownView } from './MarkdownView'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'

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

export function AssistantMessage({ item, codeFontSize, collapseToolGroups }: {
  item: Extract<TimelineItem, { role: 'assistant' }>
  codeFontSize: number
  collapseToolGroups: boolean
}) {
  const groups: Array<{ key: string; tools: ToolCallItem[] } | { key: string; text: string; thinking: boolean }> = []
  item.parts.forEach((part, index) => {
    if (part.type !== 'tool') {
      groups.push({ key: `${part.type}-${index}`, text: part.text, thinking: part.type === 'thinking' })
      return
    }
    const tool = item.toolCalls[part.toolCallId]
    if (!tool) return
    const last = groups[groups.length - 1]
    if (last && 'tools' in last) last.tools.push(tool)
    else groups.push({ key: tool.id, tools: [tool] })
  })

  return (
    <div className="msg-assistant">
      {groups.map((group, index) => {
        if (!('tools' in group)) {
          return group.thinking ? <ThinkingBlock key={group.key} text={group.text} streaming={item.streaming} />
            : <MarkdownView key={group.key} content={group.text} streaming={item.streaming && index === groups.length - 1} />
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
            <div className="tool-group-items">{group.tools.map((tool) => <ToolCallCard key={tool.id} tool={tool} codeFontSize={codeFontSize} />)}</div>
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
