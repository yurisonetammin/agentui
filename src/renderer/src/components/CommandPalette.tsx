import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import { HARNESS_LABELS } from '@shared/types'
import {
  tokenizeSearchQuery,
  type SessionSearchResponse,
  type SessionSearchResult,
} from '@shared/session-search'

export interface PaletteEntry {
  id: string
  label: string
  detail?: string
  snippet?: string
  keywords?: string
  group: '会话' | '全文' | '引擎' | '工作区' | '设置'
  run: () => void
}

/** Substring match, falling back to an in-order subsequence match (e.g. "swpi" → "switch pi"). */
function termMatches(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true
  if (term.length < 2) return false
  let from = 0
  for (const ch of term) {
    from = haystack.indexOf(ch, from)
    if (from < 0) return false
    from += 1
  }
  return true
}

function shouldRunFullText(query: string): boolean {
  const trimmed = query.trim()
  return trimmed.length >= 2 || /[\u4e00-\u9fff]/.test(trimmed)
}

function HighlightedSnippet({ text, terms }: { text: string; terms: readonly string[] }) {
  if (!text || terms.length === 0) return <>{text}</>
  const escaped = terms
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return <>{text}</>
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, idx) =>
        idx % 2 === 1 ? (
          <mark key={idx} className="palette-highlight">
            {part}
          </mark>
        ) : (
          <span key={idx}>{part}</span>
        ),
      )}
    </>
  )
}

export function CommandPalette({
  entries,
  onClose,
  onSearchSessions,
  onOpenSearchResult,
}: {
  entries: PaletteEntry[]
  onClose: () => void
  onSearchSessions?: (query: string) => Promise<SessionSearchResponse>
  onOpenSearchResult?: (hit: SessionSearchResult) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [ftsState, setFtsState] = useState<{
    loading: boolean
    response: SessionSearchResponse | null
  }>({ loading: false, response: null })
  const dialogRef = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const reqSeqRef = useRef(0)

  const terms = useMemo(() => tokenizeSearchQuery(query), [query])

  useEffect(() => {
    if (!onSearchSessions || !shouldRunFullText(query)) {
      reqSeqRef.current += 1
      setFtsState({ loading: false, response: null })
      return
    }
    const seq = ++reqSeqRef.current
    setFtsState((prev) => ({ ...prev, loading: true }))
    const timer = window.setTimeout(() => {
      void onSearchSessions(query.trim())
        .then((response) => {
          if (reqSeqRef.current === seq) {
            setFtsState({ loading: false, response })
          }
        })
        .catch(() => {
          if (reqSeqRef.current === seq) {
            setFtsState({ loading: false, response: null })
          }
        })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [query, onSearchSessions])

  const ftsEntries: PaletteEntry[] = useMemo(() => {
    if (!ftsState.response || !onOpenSearchResult) return []
    return ftsState.response.results.map((hit): PaletteEntry => {
      const rolePrefix = hit.matchedRole === 'user' ? '用户：' : hit.matchedRole === 'assistant' ? '助手：' : ''
      const sourceLabel = hit.threadId ? (hit.projectName || '当前会话') : 'CLI 历史'
      return {
        id: `fts-${hit.threadId ?? hit.sessionPath}`,
        label: hit.title,
        detail: `${sourceLabel} · ${HARNESS_LABELS[hit.harness]} · ${hit.matchCount} 处命中`,
        snippet: `${rolePrefix}${hit.snippet}`,
        group: '全文',
        run: () => onOpenSearchResult(hit),
      }
    })
  }, [ftsState.response, onOpenSearchResult])

  const matching = useMemo(() => {
    const staticMatches = entries.filter((entry) => {
      const searchable = [entry.label, entry.detail, entry.keywords, entry.group].join(' ').toLowerCase()
      return terms.every((term) => termMatches(searchable, term))
    })
    return [...staticMatches, ...ftsEntries]
  }, [entries, terms, ftsEntries])

  const index = Math.min(selectedIndex, Math.max(0, matching.length - 1))

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, query])

  function run(entry: PaletteEntry) {
    dialogRef.current?.close()
    onClose()
    entry.run()
  }

  return (
    <dialog ref={dialogRef} className="command-palette floating-card" aria-label="命令面板" onCancel={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="palette-search">
        <Search size={17} />
        <input autoFocus role="combobox" aria-label="搜索会话、历史全文、引擎或面板" aria-expanded={matching.length > 0} aria-controls="palette-results"
          aria-activedescendant={matching[index] ? `palette-option-${index}` : undefined}
          value={query} placeholder="搜索会话、历史全文、引擎或面板…"
          onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0) }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const delta = event.key === 'ArrowDown' ? 1 : -1
              if (matching.length) setSelectedIndex((index + delta + matching.length) % matching.length)
            } else if (event.key === 'Enter' && matching[index]) {
              event.preventDefault()
              run(matching[index])
            }
          }} />
        <kbd>Esc</kbd>
      </div>
      {onSearchSessions && shouldRunFullText(query) && (
        <div className="palette-fts-bar" aria-live="polite">
          {ftsState.loading
            ? '正在检索本地会话全文索引…'
            : ftsState.response
              ? `全文检索：已索引 ${ftsState.response.indexedFiles} 个会话，命中 ${ftsState.response.results.length} 条（${ftsState.response.durationMs} ms）`
              : ''}
        </div>
      )}
      <div ref={listRef} className="palette-results" id="palette-results" role="listbox" aria-label="匹配结果">
        {matching.map((entry, itemIndex) => (
          <button type="button" key={entry.id} id={`palette-option-${itemIndex}`} role="option" tabIndex={-1}
            aria-selected={index === itemIndex} onClick={() => run(entry)}>
            <span className={`palette-group${entry.group === '全文' ? ' is-fts' : ''}`}>{entry.group}</span>
            <span className="palette-label">
              {entry.label}
              {entry.snippet && (
                <small className="palette-snippet">
                  <HighlightedSnippet text={entry.snippet} terms={terms} />
                </small>
              )}
              {entry.detail && <small>{entry.detail}</small>}
            </span>
            <ArrowRight size={13} className="palette-arrow" />
          </button>
        ))}
        {matching.length === 0 && !ftsState.loading && <p className="palette-empty">没有匹配结果</p>}
      </div>
    </dialog>
  )
}
