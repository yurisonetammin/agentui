import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'

export interface PaletteEntry {
  id: string
  label: string
  detail?: string
  keywords?: string
  group: '会话' | '引擎' | '工作区' | '设置'
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

export function CommandPalette({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const matching = entries.filter((entry) => {
    const searchable = [entry.label, entry.detail, entry.keywords, entry.group].join(' ').toLowerCase()
    return terms.every((term) => termMatches(searchable, term))
  })
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
        <input autoFocus role="combobox" aria-label="搜索会话、引擎或面板" aria-expanded={matching.length > 0} aria-controls="palette-results"
          aria-activedescendant={matching[index] ? `palette-option-${index}` : undefined}
          value={query} placeholder="搜索会话、引擎或面板…"
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
      <div ref={listRef} className="palette-results" id="palette-results" role="listbox" aria-label="匹配结果">
        {matching.map((entry, itemIndex) => (
          <button type="button" key={entry.id} id={`palette-option-${itemIndex}`} role="option" tabIndex={-1}
            aria-selected={index === itemIndex} onClick={() => run(entry)}>
            <span className="palette-group">{entry.group}</span>
            <span className="palette-label">{entry.label}{entry.detail && <small>{entry.detail}</small>}</span>
            <ArrowRight size={13} className="palette-arrow" />
          </button>
        ))}
        {matching.length === 0 && <p className="palette-empty">没有匹配结果</p>}
      </div>
    </dialog>
  )
}
