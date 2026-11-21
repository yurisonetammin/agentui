import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  extractSearchableSession,
  searchIndexedSessions,
  type ExtractedSessionContent,
  type IndexedSessionDoc,
  type IndexedSessionMessage,
  type SessionSearchOptions,
  type SessionSearchResponse,
} from '@shared/session-search'
import { HARNESS_IDS, type HarnessId, type TimelineItem } from '@shared/types'
import type { HarnessDiscoveryService } from '../discovery'
import type { StateStore } from '../store'

const INDEX_SCHEMA_VERSION = 1
const MAX_JSONL_READ_BYTES = 8 * 1024 * 1024
const MAX_CLI_FILES_INDEXED = 500

interface CachedFileEntry {
  mtimeMs: number
  size: number
  extracted: ExtractedSessionContent
}

interface PersistedIndexFile {
  version: number
  entries: Record<string, CachedFileEntry>
}

function normalizeKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.replace(/\//g, '\\').toLowerCase() : filePath
}

function isVirtualSessionPath(sessionPath: string): boolean {
  return /^(codex|acp|dsh):/.test(sessionPath)
}

function readBoundedUtf8(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function collectJsonlFilesWithMtime(
  root: string,
  depth = 0,
  out: Array<{ filePath: string; mtimeMs: number; size: number }> = [],
): Array<{ filePath: string; mtimeMs: number; size: number }> {
  if (depth > 3 || !root || !existsSync(root)) return out
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(root, entry.name)
      if (entry.isDirectory()) {
        collectJsonlFilesWithMtime(full, depth + 1, out)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(full)
          out.push({ filePath: full, mtimeMs: st.mtimeMs, size: st.size })
        } catch {
          // skip unreadable file
        }
      }
    }
  } catch {
    // skip unreadable dir
  }
  return out
}

function messagesFromTimeline(items: readonly TimelineItem[]): IndexedSessionMessage[] {
  const out: IndexedSessionMessage[] = []
  for (const item of items) {
    if (item.role === 'user' && item.text.trim()) {
      out.push({ role: 'user', text: item.text })
    } else if (item.role === 'assistant') {
      const text = item.parts
        .filter((p): p is { type: 'text' | 'thinking'; text: string } => p.type === 'text' || p.type === 'thinking')
        .map((p) => p.text)
        .filter(Boolean)
        .join('\n')
      if (text.trim()) out.push({ role: 'assistant', text })
    }
  }
  return out
}

export interface SessionSearchServiceDeps {
  store: StateStore
  discovery: HarnessDiscoveryService
  /** Optional hook to read live/in-memory timelines for threads without a JSONL file. */
  getCachedTimeline?: (threadId: string) => TimelineItem[] | undefined
  /** Override index file path (defaults to sibling `session-index.json` next to `store.path`). */
  indexFilePath?: string
}

/**
 * Zero-native-dependency incremental full-text search index over AgentUI threads
 * and native CLI `.jsonl` session histories (Pi / OMP / Prime / Claude Code).
 *
 * Files are cached by `(mtimeMs, size)` and persisted atomically to `session-index.json`
 * so repeated searches and cold startups only parse newly created or modified sessions.
 */
export class SessionSearchService {
  private readonly cache = new Map<string, CachedFileEntry>()
  private readonly indexPath: string
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: SessionSearchServiceDeps) {
    this.indexPath = deps.indexFilePath ?? join(dirname(deps.store.path), 'session-index.json')
    this.loadIndexFromDisk()
  }

  private loadIndexFromDisk(): void {
    try {
      if (!existsSync(this.indexPath)) return
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Partial<PersistedIndexFile>
      if (raw.version !== INDEX_SCHEMA_VERSION || !raw.entries || typeof raw.entries !== 'object') return
      for (const [key, entry] of Object.entries(raw.entries)) {
        if (
          entry &&
          typeof entry.mtimeMs === 'number' &&
          typeof entry.size === 'number' &&
          entry.extracted &&
          Array.isArray(entry.extracted.messages)
        ) {
          this.cache.set(key, entry)
        }
      }
    } catch {
      // Corrupt or unreadable cache — rebuild incrementally on next search
    }
  }

  flushToDisk(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.indexPath), { recursive: true })
      const entries: Record<string, CachedFileEntry> = {}
      for (const [k, v] of this.cache.entries()) entries[k] = v
      const payload: PersistedIndexFile = { version: INDEX_SCHEMA_VERSION, entries }
      const tmp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, this.indexPath)
    } catch {
      // Non-fatal: in-memory cache still works
    }
  }

  private schedulePersist(): void {
    if (!this.dirty || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushToDisk()
    }, 1_500)
    this.saveTimer.unref()
  }

  private getOrParseFile(filePath: string, mtimeMs: number, size: number): ExtractedSessionContent | null {
    const key = normalizeKey(filePath)
    const cached = this.cache.get(key)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.extracted
    }
    try {
      const raw = readBoundedUtf8(filePath, MAX_JSONL_READ_BYTES)
      const fallbackId = basename(filePath).replace(/\.jsonl$/i, '')
      const extracted = extractSearchableSession(raw, fallbackId)
      this.cache.set(key, { mtimeMs, size, extracted })
      this.dirty = true
      return extracted
    } catch {
      return null
    }
  }

  search(query: string, options: SessionSearchOptions = {}): SessionSearchResponse {
    const startedAt = Date.now()
    const trimmed = query.trim()
    if (!trimmed) {
      return { query: '', results: [], indexedFiles: this.cache.size, durationMs: 0 }
    }

    const state = this.deps.store.snapshot()
    const projectById = new Map(state.projects.map((p) => [p.id, p]))
    const docsByKey = new Map<string, IndexedSessionDoc>()
    const liveFileKeys = new Set<string>()

    // 1. Index AgentUI threads first (authoritative title, project link, threadId)
    for (const thread of state.threads) {
      const project = projectById.get(thread.projectId) ?? null
      const sessionPath = thread.sessionPath ?? ''
      let extracted: ExtractedSessionContent | null = null
      let updatedAt = thread.updatedAt

      if (sessionPath && !isVirtualSessionPath(sessionPath) && existsSync(sessionPath)) {
        try {
          const st = statSync(sessionPath)
          if (st.isFile()) {
            liveFileKeys.add(normalizeKey(sessionPath))
            extracted = this.getOrParseFile(sessionPath, st.mtimeMs, st.size)
            updatedAt = Math.max(updatedAt, st.mtimeMs)
          }
        } catch {
          // ignore unreadable thread session file
        }
      }

      const memTimeline = this.deps.getCachedTimeline?.(thread.id)
      const messages =
        memTimeline && memTimeline.length > 0
          ? messagesFromTimeline(memTimeline)
          : extracted?.messages ?? []

      const docKey = sessionPath && !isVirtualSessionPath(sessionPath) ? normalizeKey(sessionPath) : `thread:${thread.id}`
      docsByKey.set(docKey, {
        key: docKey,
        sessionPath,
        sessionId: extracted?.sessionId ?? thread.id,
        harness: thread.harness,
        cwd: thread.cwd || extracted?.cwd || project?.path || '',
        title: thread.title || extracted?.title || thread.id.slice(0, 12),
        updatedAt,
        threadId: thread.id,
        projectId: thread.projectId,
        projectName: project?.name ?? null,
        messages,
      })
    }

    // 2. Incrementally index CLI native `.jsonl` files across Pi/OMP/Prime/Claude roots
    const statuses = this.deps.discovery.snapshot()
    const cliCandidates: Array<{ harness: HarnessId; filePath: string; mtimeMs: number; size: number }> = []
    for (const harness of HARNESS_IDS) {
      if (harness === 'codex' || harness === 'acp' || harness === 'dsh') continue
      if (options.harness && options.harness !== harness) continue
      const root = statuses[harness]?.sessionRoot
      if (!root) continue
      const found = collectJsonlFilesWithMtime(root)
      for (const item of found) {
        cliCandidates.push({ harness, ...item })
      }
    }

    cliCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const bounded = cliCandidates.slice(0, MAX_CLI_FILES_INDEXED)

    for (const item of bounded) {
      const key = normalizeKey(item.filePath)
      liveFileKeys.add(key)
      if (docsByKey.has(key)) continue
      const extracted = this.getOrParseFile(item.filePath, item.mtimeMs, item.size)
      if (!extracted) continue

      const matchedProject = extracted.cwd
        ? state.projects.find((p) => normalizeKey(p.path) === normalizeKey(extracted.cwd)) ?? null
        : null

      docsByKey.set(key, {
        key,
        sessionPath: item.filePath,
        sessionId: extracted.sessionId,
        harness: item.harness,
        cwd: extracted.cwd,
        title: extracted.title,
        updatedAt: item.mtimeMs,
        threadId: null,
        projectId: matchedProject?.id ?? null,
        projectName: matchedProject?.name ?? null,
        messages: extracted.messages,
      })
    }

    // Prune deleted files from persistent cache when doing an unfiltered scan
    if (!options.harness) {
      for (const key of this.cache.keys()) {
        if (!liveFileKeys.has(key)) {
          this.cache.delete(key)
          this.dirty = true
        }
      }
    }

    if (this.dirty) {
      this.schedulePersist()
    }

    const results = searchIndexedSessions([...docsByKey.values()], trimmed, options)
    return {
      query: trimmed,
      results,
      indexedFiles: liveFileKeys.size,
      durationMs: Date.now() - startedAt,
    }
  }
}
