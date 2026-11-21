import type { HarnessId } from './types'

export type SessionSearchMatchedRole = 'title' | 'user' | 'assistant'

export interface IndexedSessionMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface IndexedSessionDoc {
  /** Normalized session key (sessionPath for JSONL files, or thread:<id> for unsaved threads). */
  key: string
  sessionPath: string
  sessionId: string
  harness: HarnessId
  cwd: string
  title: string
  updatedAt: number
  threadId: string | null
  projectId: string | null
  projectName: string | null
  messages: IndexedSessionMessage[]
}

export interface SessionSearchResult {
  threadId: string | null
  projectId: string | null
  projectName: string | null
  harness: HarnessId
  sessionPath: string
  sessionId: string
  cwd: string
  title: string
  updatedAt: number
  snippet: string
  matchCount: number
  matchedRole: SessionSearchMatchedRole
}

export interface SessionSearchOptions {
  limit?: number
  harness?: HarnessId
  projectId?: string
}

export interface SessionSearchResponse {
  query: string
  results: SessionSearchResult[]
  indexedFiles: number
  durationMs: number
}

const MAX_EXTRACTED_CHARS_PER_SESSION = 256 * 1024
const MAX_SINGLE_MESSAGE_CHARS = 16 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push(part.text)
    } else if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
      // Keep thinking searchable at lower density only when non-empty
      parts.push(part.thinking)
    }
  }
  return parts.join('\n')
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export interface ExtractedSessionContent {
  sessionId: string
  cwd: string
  title: string
  messages: IndexedSessionMessage[]
}

/**
 * Extract searchable user/assistant text from either Pi/OMP/Prime `.jsonl`
 * or Claude Code `.jsonl` session content (pure function, zero native deps).
 */
export function extractSearchableSession(
  rawText: string,
  fallbackSessionId: string,
): ExtractedSessionContent {
  let sessionId = fallbackSessionId
  let cwd = ''
  let title = ''
  const messages: IndexedSessionMessage[] = []
  let totalChars = 0

  const lines = rawText.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(obj)) continue

    // 1. Pi / OMP / Prime header & metadata
    if (obj.type === 'session') {
      if (typeof obj.id === 'string' && obj.id) sessionId = obj.id
      if (typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd
      continue
    }
    if (obj.type === 'session_info' && typeof obj.name === 'string' && obj.name.trim()) {
      title = obj.name.trim()
      continue
    }

    // 2. Claude Code metadata fields
    if (typeof obj.sessionId === 'string' && obj.sessionId && sessionId === fallbackSessionId) {
      sessionId = obj.sessionId
    }
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd) {
      cwd = obj.cwd
    }

    // 3. Pi-style message entries: { type: 'message', message: { role, content } }
    let role: 'user' | 'assistant' | null = null
    let text = ''
    if (obj.type === 'message' && isRecord(obj.message)) {
      const r = obj.message.role
      if (r === 'user' || r === 'assistant') {
        role = r
        text = extractTextFromContent(obj.message.content)
      }
    } else if ((obj.type === 'user' || obj.type === 'assistant') && isRecord(obj.message)) {
      // 4. Claude-style entries: { type: 'user' | 'assistant', isSidechain?, message: { content } }
      if (obj.isSidechain === true) continue
      role = obj.type
      text = extractTextFromContent(obj.message.content)
    }

    if (!role) continue
    const trimmed = text.trim()
    if (!trimmed) continue

    if (!title && role === 'user' && !trimmed.startsWith('<')) {
      title = trimmed.split(/\r?\n/)[0].slice(0, 80)
    }

    if (totalChars >= MAX_EXTRACTED_CHARS_PER_SESSION) continue
    const clipped =
      trimmed.length > MAX_SINGLE_MESSAGE_CHARS ? trimmed.slice(0, MAX_SINGLE_MESSAGE_CHARS) : trimmed
    const remaining = MAX_EXTRACTED_CHARS_PER_SESSION - totalChars
    const stored = clipped.length > remaining ? clipped.slice(0, remaining) : clipped
    messages.push({ role, text: stored })
    totalChars += stored.length
  }

  if (!title) title = sessionId.slice(0, 12)
  return { sessionId, cwd, title, messages }
}

/** Split user query into deduplicated lowercase search tokens. */
export function tokenizeSearchQuery(query: string): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const part of query.toLowerCase().trim().split(/\s+/)) {
    if (!part || seen.has(part)) continue
    seen.add(part)
    tokens.push(part)
  }
  return tokens
}

function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower) return 0
  let count = 0
  let pos = 0
  while (pos < haystackLower.length) {
    const idx = haystackLower.indexOf(needleLower, pos)
    if (idx === -1) break
    count += 1
    pos = idx + needleLower.length
    if (count >= 50) break
  }
  return count
}

/** Build a compact single-line snippet centered around the earliest matched term. */
export function buildMatchSnippet(text: string, terms: readonly string[], maxLen = 140): string {
  const flat = normalizeWhitespace(text)
  if (!flat) return ''
  if (flat.length <= maxLen) return flat
  const lower = flat.toLowerCase()
  let bestIdx = -1
  for (const term of terms) {
    const idx = lower.indexOf(term)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx
  }
  if (bestIdx === -1) return `${flat.slice(0, maxLen - 1)}…`
  const lead = Math.floor(maxLen * 0.32)
  const start = Math.max(0, bestIdx - lead)
  const end = Math.min(flat.length, start + maxLen)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  return `${prefix}${flat.slice(start, end).trim()}${suffix}`
}

/**
 * Full-text search across indexed sessions.
 * All query tokens must appear somewhere in the session (title, cwd, projectName, or messages).
 */
export function searchIndexedSessions(
  docs: readonly IndexedSessionDoc[],
  query: string,
  options: SessionSearchOptions = {},
): SessionSearchResult[] {
  const terms = tokenizeSearchQuery(query)
  if (terms.length === 0) return []

  const phrase = query.toLowerCase().trim()
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100))
  const scored: Array<{ score: number; result: SessionSearchResult }> = []

  for (const doc of docs) {
    if (options.harness && doc.harness !== options.harness) continue
    if (options.projectId && doc.projectId !== options.projectId) continue

    const titleLower = doc.title.toLowerCase()
    const metaLower = `${titleLower}\n${doc.cwd.toLowerCase()}\n${(doc.projectName ?? '').toLowerCase()}`

    // Track which terms are matched anywhere in the document
    const foundTerms = new Set<string>()
    let titleMatches = 0
    for (const term of terms) {
      if (metaLower.includes(term)) {
        foundTerms.add(term)
        if (titleLower.includes(term)) titleMatches += 1
      }
    }

    let totalMatches = titleMatches
    let bestMsg: { role: 'user' | 'assistant'; text: string; score: number } | null = null

    for (const msg of doc.messages) {
      const lower = msg.text.toLowerCase()
      let msgHits = 0
      let distinctInMsg = 0
      for (const term of terms) {
        const c = countOccurrences(lower, term)
        if (c > 0) {
          foundTerms.add(term)
          distinctInMsg += 1
          msgHits += c
        }
      }
      if (msgHits === 0) continue
      totalMatches += msgHits

      let msgScore = distinctInMsg * 25 + Math.min(msgHits, 10) * 3
      if (phrase.length > 1 && lower.includes(phrase)) msgScore += 35
      if (msg.role === 'user') msgScore += 6

      if (!bestMsg || msgScore > bestMsg.score) {
        bestMsg = { role: msg.role, text: msg.text, score: msgScore }
      }
    }

    if (foundTerms.size < terms.length) continue

    let score = 0
    if (titleMatches > 0) {
      score += titleMatches * 40
      if (phrase.length > 1 && titleLower.includes(phrase)) score += 60
    }
    if (bestMsg) score += bestMsg.score
    score += Math.min(20, totalMatches * 2)
    if (doc.threadId) score += 15

    const matchedRole: SessionSearchMatchedRole = bestMsg ? bestMsg.role : 'title'
    const snippetSource = bestMsg ? bestMsg.text : doc.title
    const snippet = buildMatchSnippet(snippetSource, terms)

    scored.push({
      score,
      result: {
        threadId: doc.threadId,
        projectId: doc.projectId,
        projectName: doc.projectName,
        harness: doc.harness,
        sessionPath: doc.sessionPath,
        sessionId: doc.sessionId,
        cwd: doc.cwd,
        title: doc.title,
        updatedAt: doc.updatedAt,
        snippet,
        matchCount: Math.max(1, totalMatches),
        matchedRole,
      },
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.result.updatedAt - a.result.updatedAt
  })

  return scored.slice(0, limit).map((item) => item.result)
}
