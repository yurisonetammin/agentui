import { useEffect, useState } from 'react'
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react'
import type { ExternalEditorId, ExternalEditorInfo, WorkspaceDirEntry, WorkspaceFileContent } from '@shared/types'
import { CodeMirrorEditor, type CodeSelectionRange } from './CodeMirrorEditor'

interface WorkspaceFilesPanelProps {
  cwd: string
  onReferenceFile?: (relPath: string) => void
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function WorkspaceFilesPanel({ cwd, onReferenceFile }: WorkspaceFilesPanelProps) {
  const [treeCache, setTreeCache] = useState<Record<string, WorkspaceDirEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loadingDir, setLoadingDir] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<WorkspaceFileContent | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [selectionRange, setSelectionRange] = useState<CodeSelectionRange | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [editors, setEditors] = useState<ExternalEditorInfo[]>([])

  const isDirty = Boolean(file && !file.binary && !file.truncated && draftContent !== file.content)

  useEffect(() => {
    void window.agentui.listExternalEditors().then(setEditors).catch(() => undefined)
  }, [])

  async function loadDir(relPath: string) {
    if (!cwd) return
    setLoadingDir(relPath)
    setError(null)
    try {
      const entries = await window.agentui.listWorkspaceDir(cwd, relPath)
      setTreeCache((prev) => ({ ...prev, [relPath]: entries }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingDir((cur) => (cur === relPath ? null : cur))
    }
  }

  async function refreshAllDirs() {
    if (!cwd) return
    const openDirs = ['', ...Object.keys(expanded).filter((k) => expanded[k])]
    for (const dir of openDirs) {
      await loadDir(dir)
    }
  }

  useEffect(() => {
    setTreeCache({})
    setExpanded({})
    setSelectedPath(null)
    setFile(null)
    setDraftContent('')
    setSelectionRange(null)
    setSaveFeedback(null)
    setError(null)
    if (cwd) void loadDir('')
  }, [cwd])

  async function toggleDir(relPath: string) {
    const next = !expanded[relPath]
    setExpanded((prev) => ({ ...prev, [relPath]: next }))
    if (next && !treeCache[relPath]) {
      await loadDir(relPath)
    }
  }

  async function openFile(relPath: string) {
    if (!cwd) return
    if (isDirty && relPath !== selectedPath && !window.confirm('当前文件有未保存的修改，确定放弃并切换文件？')) {
      return
    }
    setSelectedPath(relPath)
    setLoadingFile(true)
    setError(null)
    setSaveFeedback(null)
    setSelectionRange(null)
    try {
      const content = await window.agentui.readWorkspaceFile(cwd, relPath)
      setFile(content)
      setDraftContent(content.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setFile(null)
      setDraftContent('')
    } finally {
      setLoadingFile(false)
    }
  }

  async function handleSave() {
    if (!cwd || !file || file.binary || file.truncated || !isDirty || saving) return
    setSaving(true)
    setError(null)
    setSaveFeedback(null)
    try {
      const res = await window.agentui.writeWorkspaceFile(cwd, file.path, draftContent)
      setFile((prev) => (prev ? { ...prev, content: draftContent, sizeBytes: res.sizeBytes } : prev))
      setSaveFeedback('已保存')
      window.setTimeout(() => setSaveFeedback(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleOpenExternal(editor?: ExternalEditorId) {
    if (!cwd || !file) return
    setError(null)
    try {
      await window.agentui.openInExternalEditor(cwd, file.path, selectionRange?.startLine, editor)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleReference() {
    if (!file || !onReferenceFile) return
    if (selectionRange) {
      const tag =
        selectionRange.startLine === selectionRange.endLine
          ? `${file.path}#L${selectionRange.startLine}`
          : `${file.path}#L${selectionRange.startLine}-L${selectionRange.endLine}`
      onReferenceFile(tag)
    } else {
      onReferenceFile(file.path)
    }
  }

  function renderEntries(parentRel: string, depth: number) {
    const list = treeCache[parentRel]
    if (!list) return null
    return list.map((entry) => {
      if (entry.isDirectory) {
        const isOpen = Boolean(expanded[entry.path])
        return (
          <div key={entry.path}>
            <button
              type="button"
              className="ws-tree-row"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => void toggleDir(entry.path)}
              title={entry.path}
            >
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
              <span className="ws-tree-name">{entry.name}</span>
            </button>
            {isOpen && renderEntries(entry.path, depth + 1)}
          </div>
        )
      }
      const active = selectedPath === entry.path
      return (
        <button
          key={entry.path}
          type="button"
          className={`ws-tree-row ${active ? 'active' : ''}`}
          style={{ paddingLeft: 22 + depth * 14 }}
          onClick={() => void openFile(entry.path)}
          title={entry.path}
        >
          <FileCode2 size={13} />
          <span className="ws-tree-name">{entry.name}</span>
          {entry.sizeBytes !== undefined && (
            <span className="ws-tree-size">{formatBytes(entry.sizeBytes)}</span>
          )}
        </button>
      )
    })
  }

  const rootEntries = treeCache['']
  const availableIdes = editors.filter((e) => e.id !== 'explorer' && e.available)
  const explorerLabel = editors.find((e) => e.id === 'explorer')?.label ?? '资源管理器'

  return (
    <div className="ws-files-panel">
      <div className="ws-files-toolbar">
        <span className="ws-files-title" title={cwd}>
          工作区文件
        </span>
        <div className="ws-files-actions">
          <button
            type="button"
            className="icon-btn"
            title="刷新目录"
            aria-label="刷新目录"
            onClick={() => void refreshAllDirs()}
          >
            <RefreshCw size={12} className={loadingDir !== null ? 'spin' : undefined} />
          </button>
        </div>
      </div>

      {error && (
        <div className="msg-notice error" style={{ margin: '6px 8px 0' }}>
          {error}
        </div>
      )}

      <div className="ws-files-split">
        <div className="ws-tree">
          {!cwd && <div className="ws-empty">请先选择一个项目。</div>}
          {cwd && !rootEntries && loadingDir === '' && <div className="ws-empty">读取目录中…</div>}
          {cwd && rootEntries && rootEntries.length === 0 && <div className="ws-empty">目录为空</div>}
          {cwd && rootEntries && renderEntries('', 0)}
        </div>

        <div className="ws-preview">
          {!selectedPath && (
            <div className="ws-empty">点击上方文件使用 CodeMirror 6 查看或轻度编辑（Ctrl+S 保存）。</div>
          )}
          {selectedPath && loadingFile && <div className="ws-empty">读取文件…</div>}
          {selectedPath && !loadingFile && file && (
            <>
              <div className="ws-preview-head">
                <span className="ws-preview-path" title={file.path}>
                  {file.path}
                  {isDirty && <span className="ws-dirty-badge" title="有未保存的修改">● 未保存</span>}
                  {saveFeedback && <span className="ws-saved-badge">{saveFeedback}</span>}
                </span>
                <div className="ws-preview-actions">
                  <span className="ws-tree-size">{formatBytes(file.sizeBytes)}</span>
                  {!file.binary && !file.truncated && (
                    <>
                      <button
                        type="button"
                        className="btn-small"
                        disabled={!isDirty || saving}
                        title="保存修改 (Ctrl+S)"
                        onClick={() => void handleSave()}
                      >
                        <Save size={11} />
                        {saving ? '保存中…' : '保存'}
                      </button>
                      {isDirty && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="放弃未保存的修改"
                          aria-label="放弃修改"
                          onClick={() => setDraftContent(file.content)}
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </>
                  )}
                  {onReferenceFile && (
                    <button
                      type="button"
                      className="btn-small"
                      title={
                        selectionRange
                          ? `引用选中行 @${file.path}#L${selectionRange.startLine}-L${selectionRange.endLine}`
                          : '插入 @路径 引用到输入框'
                      }
                      onClick={handleReference}
                    >
                      <AtSign size={11} />
                      {selectionRange
                        ? selectionRange.startLine === selectionRange.endLine
                          ? `引用 L${selectionRange.startLine}`
                          : `引用 L${selectionRange.startLine}-${selectionRange.endLine}`
                        : '引用'}
                    </button>
                  )}
                  {availableIdes.length > 0 ? (
                    availableIdes.map((ide) => (
                      <button
                        key={ide.id}
                        type="button"
                        className="btn-small"
                        title={`在 ${ide.label} 中打开${selectionRange ? `并跳转到第 ${selectionRange.startLine} 行` : ''}`}
                        onClick={() => void handleOpenExternal(ide.id)}
                      >
                        <Code2 size={11} />
                        {ide.label}
                      </button>
                    ))
                  ) : (
                    <button
                      type="button"
                      className="btn-small"
                      title={`在${explorerLabel}中显示`}
                      onClick={() => void handleOpenExternal('explorer')}
                    >
                      <ExternalLink size={11} />
                      {explorerLabel}
                    </button>
                  )}
                  {availableIdes.length > 0 && (
                    <button
                      type="button"
                      className="icon-btn"
                      title={`在${explorerLabel}中显示`}
                      aria-label={`在${explorerLabel}中显示`}
                      onClick={() => void handleOpenExternal('explorer')}
                    >
                      <ExternalLink size={12} />
                    </button>
                  )}
                  {!file.binary && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="复制全文"
                      aria-label="复制全文"
                      onClick={() => {
                        void navigator.clipboard.writeText(draftContent)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1500)
                      }}
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  )}
                </div>
              </div>
              {file.binary ? (
                <div className="ws-empty">二进制文件，不支持文本预览与编辑。</div>
              ) : (
                <>
                  {file.truncated && (
                    <div className="msg-notice info" style={{ margin: '6px 8px 0' }}>
                      文件大于 512 KB，仅展示前 512 KB（只读模式，请在外部编辑器中修改）。
                    </div>
                  )}
                  <div className="ws-cm-wrap">
                    <CodeMirrorEditor
                      filePath={file.path}
                      language={file.language}
                      value={draftContent}
                      readOnly={file.truncated}
                      onChange={setDraftContent}
                      onSave={() => void handleSave()}
                      onSelectionChange={setSelectionRange}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
