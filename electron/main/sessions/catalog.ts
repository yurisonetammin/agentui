import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CliSessionSummary, HarnessId, TimelineItem, ToolCallItem } from '@shared/types'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function collectJsonlFiles(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || !existsSync(root)) return out
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(root, entry.name)
      if (entry.isDirectory()) {
        collectJsonlFiles(full, depth + 1, out)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full)
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return out
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (isRecord(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function scanCliSessions(harness: HarnessId, sessionRoot: string, limit = 30): CliSessionSummary[] {
  const files = collectJsonlFiles(sessionRoot)
  const summaries: CliSessionSummary[] = []

  for (const filePath of files) {
    try {
      const st = statSync(filePath)
      const text = readFileSync(filePath, 'utf8')
      const lines = text.split(/\r?\n/).filter(Boolean)
      if (lines.length === 0) continue

      let sessionId = filePath
      let cwd = ''
      let title = ''
      for (const line of lines.slice(0, 40)) {
        try {
          const obj = JSON.parse(line) as unknown
          if (!isRecord(obj)) continue
          if (obj.type === 'session') {
            if (typeof obj.id === 'string') sessionId = obj.id
            if (typeof obj.cwd === 'string') cwd = obj.cwd
          } else if (obj.type === 'session_info' && typeof obj.name === 'string' && obj.name.trim()) {
            title = obj.name.trim()
          } else if (!title && obj.type === 'message' && isRecord(obj.message) && obj.message.role === 'user') {
            const firstPrompt = extractTextContent(obj.message.content).trim()
            if (firstPrompt) title = firstPrompt.split(/\r?\n/)[0].slice(0, 80)
          }
        } catch {
          // ignore malformed line
        }
      }
      if (!title) title = sessionId.slice(0, 12)
      summaries.push({
        harness,
        sessionPath: filePath,
        sessionId,
        cwd,
        title,
        updatedAt: st.mtimeMs,
      })
    } catch {
      // skip unreadable file
    }
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return summaries.slice(0, limit)
}

export function readSessionTimeline(sessionPath: string): TimelineItem[] {
  if (!existsSync(sessionPath)) return []
  try {
    const lines = readFileSync(sessionPath, 'utf8').split(/\r?\n/).filter(Boolean)
    const items: TimelineItem[] = []
    const toolIndexMap = new Map<string, { assistantIdx: number }>()

    for (let i = 0; i < lines.length; i += 1) {
      let obj: unknown
      try {
        obj = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (!isRecord(obj)) continue
      if (obj.type === 'compaction') {
        items.push({
          id: `hist-cmp-${i}`,
          role: 'notice',
          kind: 'compaction',
          text: typeof obj.summary === 'string' ? `历史压缩摘要: ${obj.summary.slice(0, 180)}` : '历史上下文已压缩',
          timestamp: Date.now(),
        })
        continue
      }
      if (obj.type !== 'message' || !isRecord(obj.message)) continue
      const msg = obj.message
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
      const role = typeof msg.role === 'string' ? msg.role : ''

      if (role === 'user') {
        const text = extractTextContent(msg.content)
        if (text) {
          items.push({ id: `hist-u-${i}`, role: 'user', text, timestamp: ts })
        }
      } else if (role === 'assistant') {
        const parts: Extract<TimelineItem, { role: 'assistant' }>['parts'] = []
        const toolCalls: Record<string, ToolCallItem> = {}
        const content = Array.isArray(msg.content) ? msg.content : []
        for (const block of content) {
          if (!isRecord(block)) continue
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            parts.push({ type: 'thinking', text: block.thinking })
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'toolCall' && typeof block.id === 'string') {
            const args = isRecord(block.arguments) ? block.arguments : undefined
            toolCalls[block.id] = {
              id: block.id,
              name: typeof block.name === 'string' ? block.name : 'tool',
              args,
              argsText: args ? JSON.stringify(args, null, 2) : '',
              status: 'success',
              output: '',
              isError: false,
            }
            parts.push({ type: 'tool', toolCallId: block.id })
          }
        }
        const assistantIdx = items.length
        for (const callId of Object.keys(toolCalls)) {
          toolIndexMap.set(callId, { assistantIdx })
        }
        items.push({
          id: `hist-a-${i}`,
          role: 'assistant',
          parts,
          toolCalls,
          streaming: false,
          stopReason: typeof msg.stopReason === 'string' ? msg.stopReason : undefined,
          errorMessage: typeof msg.errorMessage === 'string' ? msg.errorMessage : undefined,
          model: typeof msg.model === 'string' ? msg.model : undefined,
          timestamp: ts,
        })
      } else if (role === 'toolResult' && typeof msg.toolCallId === 'string') {
        const ref = toolIndexMap.get(msg.toolCallId)
        if (!ref) continue
        const target = items[ref.assistantIdx]
        if (target?.role === 'assistant' && target.toolCalls[msg.toolCallId]) {
          const isError = msg.isError === true
          target.toolCalls[msg.toolCallId] = {
            ...target.toolCalls[msg.toolCallId],
            status: isError ? 'error' : 'success',
            isError,
            output: extractTextContent(msg.content),
          }
        }
      }
    }
    return items
  } catch {
    return []
  }
}
