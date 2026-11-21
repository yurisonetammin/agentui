import { useCallback, useEffect, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { AtSign, ChevronDown, ChevronRight, Copy, FileText, Folder, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import type { WorkspaceDirEntry, WorkspaceFileContent } from '@shared/types'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightContent(file: WorkspaceFileContent): string {
  if (file.binary) return ''
  const code = file.content
  // Skip expensive highlighting for very large previews
  if (code.length > 200_000) return escapeHtml(code)
  if (file.language && hljs.getLanguage(file.language)) {
    try {
      return hljs.highlight(code, { language: file.language, ignoreIllegals: true }).value
    } catch {
      // fall through to plain
    }
  }
  return escapeHtml(code)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function WorkspaceFilesPanel({
  cwd,
  onReferenceFile,
}: {
  cwd: string
  onReferenceFile?: (relPath: string) => void
}) {
  const [rootEntries, setRootEntries] = useState<WorkspaceDirEntry[]>([])
  const [children, setChildren] = useState<Record<string, WorkspaceDirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<WorkspaceFileContent | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const fileReqIdRef = useRef(0)

  const loadRoot = useCallback(async () => {
    setError(null)
    try {
      const entries = await window.agentui.listWorkspaceDir(cwd, '')
      setRootEntries(entries)
    } catch (err) {
      setRootEntries([])
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [cwd])

  useEffect(() => {
    setRootEntries([])
    setChildren({})
    setExpanded(new Set())
    setSelectedPath(null)
    setFile(null)
    void loadRoot()
  }, [loadRoot])

  async function toggleDir(relPath: string) {
    if (expanded.has(relPath)) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.delete(relPath)
        return next
      })
      return
    }
    setExpanded((prev) => new Set(prev).add(relPath))
    if (children[relPath]) return
    setLoadingDirs((prev) => new Set(prev).add(relPath))
    try {
      const entries = await window.agentui.listWorkspaceDir(cwd, relPath)
      setChildren((prev) => ({ ...prev, [relPath]: entries }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(relPath)
        return next
      })
    }
  }

  async function openFile(relPath: string) {
    const reqId = (fileReqIdRef.current += 1)
    setSelectedPath(relPath)
    setFileLoading(true)
    setCopied(false)
    try {
      const content = await window.agentui.readWorkspaceFile(cwd, relPath)
      if (fileReqIdRef.current === reqId) setFile(content)
    } catch (err) {
      if (fileReqIdRef.current === reqId) {
        setFile(null)
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (fileReqIdRef.current === reqId) setFileLoading(false)
    }
  }

  function renderEntries(entries: WorkspaceDirEntry[], depth: number) {
    return entries.map((entry) => {
      const indent = 8 + depth * 14
      if (entry.isDirectory) {
        const isOpen = expanded.has(entry.path)
        const isLoading = loadingDirs.has(entry.path)
        return (
          <div key={`d:${entry.path}`}>
            <button
              type="button"
              className="ws-tree-row"
              style={{ paddingLeft: indent }}
              onClick={() => void toggleDir(entry.path)}
              title={entry.path}
            >
              {isLoading ? (
                <Loader2 size={12} className="spin" />
              ) : isOpen ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
              {isOpen ? <FolderOpen size={13} color="var(--accent)" /> : <Folder size={13} color="var(--accent)" />}
              <span className="ws-tree-name">{entry.name}</span>
            </button>
            {isOpen && children[entry.path] && renderEntries(children[entry.path], depth + 1)}
          </div>
        )
      }
      return (
        <button
          key={`f:${entry.path}`}
          type="button"
          className={`ws-tree-row ${selectedPath === entry.path ? 'active' : ''}`}
          style={{ paddingLeft: indent + 12 }}
          onClick={() => void openFile(entry.path)}
          title={`${entry.path}${entry.sizeBytes !== undefined ? ` · ${formatBytes(entry.sizeBytes)}` : ''}`}
        >
          <FileText size={13} color="var(--text-secondary)" />
          <span className="ws-tree-name">{entry.name}</span>
          {entry.sizeBytes !== undefined && entry.sizeBytes > 1024 * 1024 && (
            <span className="ws-tree-size">{formatBytes(entry.sizeBytes)}</span>
          )}
        </button>
      )
    })
  }

  return (
    <div className="ws-files-panel">
      <div className="ws-tree-pane">
        <div className="ws-tree-toolbar">
          <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cwd}>
            {cwd}
          </span>
          <button type="button" className="icon-btn" title="刷新文件树" onClick={() => void loadRoot()}>
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="ws-tree-scroll">
          {error && <div className="msg-notice error" style={{ margin: 6 }}>{error}</div>}
          {rootEntries.length === 0 && !error && (
            <div style={{ padding: 10, fontSize: 12.5, color: 'var(--text-muted)' }}>目录为空或不可读。</div>
          )}
          {renderEntries(rootEntries, 0)}
        </div>
      </div>

      <div className="ws-preview-pane">
        {!selectedPath ? (
          <div className="ws-preview-empty">点击左侧文件查看只读高亮预览（不会修改任何文件）。</div>
        ) : fileLoading ? (
          <div className="ws-preview-empty">
            <Loader2 size={14} className="spin" /> 读取中...
          </div>
        ) : file ? (
          <>
            <div className="ws-preview-header">
              <span className="ws-preview-path" title={file.path}>{file.path}</span>
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)', flexShrink: 0 }}>
                {formatBytes(file.sizeBytes)}
                {file.language ? ` · ${file.language}` : ''}
              </span>
              {onReferenceFile && (
                <button
                  type="button"
                  className="icon-btn"
                  title="在输入框中 @ 引用此文件"
                  onClick={() => onReferenceFile(file.path)}
                >
                  <AtSign size={12} />
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                title="复制文件内容"
                disabled={file.binary}
                onClick={() => {
                  void navigator.clipboard?.writeText(file.content).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
              >
                <Copy size={12} color={copied ? 'var(--success)' : undefined} />
              </button>
            </div>
            {file.binary ? (
              <div className="ws-preview-empty">二进制文件，无法预览。</div>
            ) : (
              <>
                {file.truncated && (
                  <div className="msg-notice warning" style={{ margin: '6px 8px 0' }}>
                    文件过大，仅预览前 512 KB。
                  </div>
                )}
                <pre className="ws-preview-code">
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightContent(file) }} />
                </pre>
              </>
            )}
          </>
        ) : (
          <div className="ws-preview-empty">无法读取该文件。</div>
        )}
      </div>
    </div>
  )
}