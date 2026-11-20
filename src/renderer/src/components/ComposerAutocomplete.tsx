import { useEffect, useRef } from 'react'
import { FileCode2, Terminal } from 'lucide-react'
import type { SlashCommandDescriptor, WorkspaceFileEntry } from '@shared/types'

const SOURCE_LABELS: Record<SlashCommandDescriptor['source'], string> = {
  builtin: '工作台',
  skill: 'Skill',
  prompt: '模板',
  extension: '扩展',
}

export function ComposerAutocomplete({
  kind,
  query,
  files,
  commands,
  selectedIndex,
  loading = false,
  onSelectFile,
  onSelectCommand,
  onHoverIndex,
}: {
  kind: 'file' | 'slash'
  query: string
  files: WorkspaceFileEntry[]
  commands: SlashCommandDescriptor[]
  selectedIndex: number
  loading?: boolean
  onSelectFile: (entry: WorkspaceFileEntry) => void
  onSelectCommand: (cmd: SlashCommandDescriptor) => void
  onHoverIndex: (idx: number) => void
}) {
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-ac-index="${selectedIndex}"]`)
    if (el && 'scrollIntoView' in el) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const count = kind === 'file' ? files.length : commands.length

  return (
    <div className="autocomplete-popover" role="listbox">
      <div className="autocomplete-header">
        <span>
          {kind === 'file'
            ? `引用工作区文件 ${query ? `· "${query}"` : ''}`
            : `斜杠命令 ${query ? `· /${query}` : ''}`}
        </span>
        <span className="autocomplete-hint">↑↓ 选择 · Tab / Enter 确认 · Esc 关闭</span>
      </div>

      <div className="autocomplete-list" ref={listRef}>
        {loading && count === 0 ? (
          <div className="autocomplete-empty">正在扫描工作区文件...</div>
        ) : count === 0 ? (
          <div className="autocomplete-empty">
            {kind === 'file' ? '未找到匹配的工作区文件' : '未找到匹配的命令'}
          </div>
        ) : kind === 'file' ? (
          files.map((entry, idx) => {
            const slashPos = entry.path.lastIndexOf('/')
            const dir = slashPos === -1 ? '' : entry.path.slice(0, slashPos)
            return (
              <button
                key={entry.path}
                type="button"
                data-ac-index={idx}
                className={`autocomplete-item ${idx === selectedIndex ? 'active' : ''}`}
                onMouseEnter={() => onHoverIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onSelectFile(entry)
                }}
              >
                <FileCode2 size={13} color="var(--accent)" style={{ flexShrink: 0 }} />
                <span className="ac-primary">{entry.name}</span>
                {dir && <span className="ac-secondary">{dir}</span>}
              </button>
            )
          })
        ) : (
          commands.map((cmd, idx) => (
            <button
              key={`${cmd.source}:${cmd.name}`}
              type="button"
              data-ac-index={idx}
              className={`autocomplete-item ${idx === selectedIndex ? 'active' : ''}`}
              onMouseEnter={() => onHoverIndex(idx)}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelectCommand(cmd)
              }}
            >
              <Terminal size={13} color="var(--omp-color)" style={{ flexShrink: 0 }} />
              <span className="ac-primary">/{cmd.name}</span>
              {cmd.argsHint && <span className="ac-args">{cmd.argsHint}</span>}
              {cmd.description && <span className="ac-secondary">{cmd.description}</span>}
              <span className={`ac-source source-${cmd.source}`}>{SOURCE_LABELS[cmd.source]}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
