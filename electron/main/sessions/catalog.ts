import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  CliSessionSummary,
  HarnessId,
  ImageAttachment,
  SessionForkMessage,
  SessionTreeSnapshot,
  TimelineItem,
  ToolCallItem,
} from '@shared/types'

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

function extractImagesContent(content: unknown, seed: string): ImageAttachment[] {
  if (!Array.isArray(content)) return []
  const images: ImageAttachment[] = []
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i]
    if (!isRecord(part)) continue
    if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      images.push({
        id: `${seed}-img-${i}`,
        type: 'image',
        data: part.data,
        mimeType: part.mimeType,
      })
    }
  }
  return images
}

interface ParsedSessionFile {
  header: Record<string, unknown> | null
  entries: Record<string, unknown>[]
  byId: Map<string, Record<string, unknown>>
  leafId: string | null
  activeBranch: Record<string, unknown>[]
}

function parseSessionFile(sessionPath: string): ParsedSessionFile | null {
  if (!sessionPath || !existsSync(sessionPath)) return null
  try {
    const lines = readFileSync(sessionPath, 'utf8').split(/\r?\n/).filter(Boolean)
    let header: Record<string, unknown> | null = null
    const entries: Record<string, unknown>[] = []
    const byId = new Map<string, Record<string, unknown>>()
    let leafId: string | null = null

    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed)) continue
      if (parsed.type === 'session' && !header) {
        header = parsed
        continue
      }
      entries.push(parsed)
      if (typeof parsed.id === 'string' && parsed.id) {
        byId.set(parsed.id, parsed)
        leafId = parsed.id
      }
    }

    // Resolve active ancestry chain from leafId back to root when tree IDs exist
    let activeBranch: Record<string, unknown>[]
    if (leafId && byId.size > 0) {
      const chain: Record<string, unknown>[] = []
      const visited = new Set<string>()
      let curId: string | null = leafId
      while (curId && !visited.has(curId)) {
        visited.add(curId)
        const node = byId.get(curId)
        if (!node) break
        chain.push(node)
        curId = typeof node.parentId === 'string' ? node.parentId : null
      }
      chain.reverse()
      activeBranch = chain
    } else {
      activeBranch = entries
    }

    return { header, entries, byId, leafId, activeBranch }
  } catch {
    return null
  }
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
  const parsed = parseSessionFile(sessionPath)
  if (!parsed) return []

  const items: TimelineItem[] = []
  const toolIndexMap = new Map<string, { assistantIdx: number }>()

  for (let i = 0; i < parsed.activeBranch.length; i += 1) {
    const obj = parsed.activeBranch[i]
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
      const images = extractImagesContent(msg.content, `hist-u-${i}`)
      if (text || images.length > 0) {
        items.push({
          id: `hist-u-${i}`,
          role: 'user',
          text,
          images: images.length > 0 ? images : undefined,
          timestamp: ts,
        })
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
}

export function readSessionForkTree(sessionPath: string | null | undefined): SessionTreeSnapshot {
  if (!sessionPath) {
    return { sessionPath: null, leafId: null, messages: [], supportsNativeFork: false }
  }
  const parsed = parseSessionFile(sessionPath)
  if (!parsed) {
    return { sessionPath, leafId: null, messages: [], supportsNativeFork: false }
  }

  const messages: SessionForkMessage[] = []
  const branch = parsed.activeBranch

  for (let i = 0; i < branch.length; i += 1) {
    const entry = branch[i]
    if (entry.type !== 'message' || !isRecord(entry.message)) continue
    if (entry.message.role !== 'user') continue

    const entryId = typeof entry.id === 'string' ? entry.id : `line-${i}`
    const parentId = typeof entry.parentId === 'string' ? entry.parentId : null
    const text = extractTextContent(entry.message.content).trim()
    if (!text) continue

    // Find immediate assistant reply preview before next user message
    let assistantPreview: string | undefined
    let model: string | undefined
    for (let j = i + 1; j < branch.length; j += 1) {
      const nextEntry = branch[j]
      if (nextEntry.type !== 'message' || !isRecord(nextEntry.message)) continue
      if (nextEntry.message.role === 'user') break
      if (nextEntry.message.role === 'assistant') {
        if (!model && typeof nextEntry.message.model === 'string') {
          model = nextEntry.message.model
        }
        const replyText = extractTextContent(nextEntry.message.content).trim()
        if (replyText) {
          assistantPreview = replyText.slice(0, 180)
        }
      }
    }

    messages.push({
      entryId,
      parentId,
      text,
      timestamp: typeof entry.message.timestamp === 'number' ? entry.message.timestamp : undefined,
      assistantPreview,
      model,
      depth: messages.length,
    })
  }

  return {
    sessionPath,
    leafId: parsed.leafId,
    messages,
    supportsNativeFork: true,
  }
}

/**
 * Creates a non-destructive forked `.jsonl` session file alongside `sourceSessionPath`.
 * - If `entryId` is specified, retains all ancestor entries strictly BEFORE `entryId`
 *   (matching Pi `/fork` & OMP `/branch` semantics) and returns `entryId`'s prompt as `prefillText`.
 * - If `entryId` is omitted/null, clones the full active branch up to the current leaf.
 */
export function createForkedSessionFile(
  sourceSessionPath: string,
  entryId?: string | null,
): { sessionPath: string; prefillText?: string } {
  const parsed = parseSessionFile(sourceSessionPath)
  if (!parsed) {
    throw new Error(`无法读取源会话文件: ${sourceSessionPath}`)
  }

  let keptEntries: Record<string, unknown>[]
  let prefillText: string | undefined

  if (entryId) {
    const target = parsed.byId.get(entryId)
    if (!target) {
      throw new Error(`未在会话中找到分叉节点: ${entryId}`)
    }
    if (target.type === 'message' && isRecord(target.message)) {
      const txt = extractTextContent(target.message.content).trim()
      if (txt) prefillText = txt
    }
    const chain: Record<string, unknown>[] = []
    const visited = new Set<string>()
    let curId: string | null = typeof target.parentId === 'string' ? target.parentId : null
    while (curId && !visited.has(curId)) {
      visited.add(curId)
      const node = parsed.byId.get(curId)
      if (!node) break
      chain.push(node)
      curId = typeof node.parentId === 'string' ? node.parentId : null
    }
    chain.reverse()
    keptEntries = chain
  } else {
    keptEntries = [...parsed.activeBranch]
  }

  const newSessionId = randomUUID()
  const nowIso = new Date().toISOString()
  const safeTs = nowIso.replace(/[:.]/g, '-')
  const dir = dirname(sourceSessionPath)
  mkdirSync(dir, { recursive: true })
  const destPath = join(dir, `${safeTs}_${newSessionId}.jsonl`)
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`

  const newHeader: Record<string, unknown> = {
    ...(parsed.header ?? {}),
    type: 'session',
    version: typeof parsed.header?.version === 'number' ? parsed.header.version : 3,
    id: newSessionId,
    timestamp: nowIso,
    parentSession: sourceSessionPath,
  }

  const lines = [JSON.stringify(newHeader), ...keptEntries.map((entry) => JSON.stringify(entry))]
  writeFileSync(tmpPath, `${lines.join('\n')}\n`, 'utf8')
  renameSync(tmpPath, destPath)

  return { sessionPath: destPath, prefillText }
}
