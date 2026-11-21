import { useEffect, useRef } from 'react'
import { AppWindow, ArrowLeft, ChevronDown, Command, Files, GitCompareArrows, GitFork, Globe, Minimize2, Terminal } from 'lucide-react'
import { HARNESS_LABELS, type ContextUsageInfo, type HarnessId, type ThreadEntry } from '@shared/types'
import brandIcon from '../assets/brand-icon.png'
import { statusDotClass, statusLabel } from '../workbench'
import type { WorkspacePanelTab } from './DiffPanel'

export const WORKSPACE_TOOLS = [
  { tab: 'changes', label: '变更', icon: GitCompareArrows },
  { tab: 'files', label: '文件', icon: Files },
  { tab: 'terminal', label: '终端', icon: Terminal },
  { tab: 'browser', label: '浏览器', icon: Globe },
] as const

interface Props {
  thread: ThreadEntry | null
  harness: HarnessId
  ready: boolean
  cwd: string | null
  context: ContextUsageInfo | undefined
  statusText: string | null | undefined
  activeTool: WorkspacePanelTab | null
  terminalDocked: boolean
  onToggleTool: (tab: WorkspacePanelTab) => void
  onOpenPalette: () => void
  onOpenBrowserWindow: () => void
  onFork: () => void
  onCompact: () => void
  onCloseSettings?: () => void
}

export function WorkbenchHeader({
  thread, harness, ready, cwd, context, statusText, activeTool, terminalDocked,
  onToggleTool, onOpenPalette, onOpenBrowserWindow, onFork, onCompact, onCloseSettings,
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const status = statusText || (thread ? statusLabel(thread.status) : ready ? '引擎就绪' : '引擎未就绪')

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      const menu = detailsRef.current
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  function closeThen(action: () => void) {
    if (detailsRef.current) detailsRef.current.open = false
    action()
  }

  return (
    <header className="topbar">
      <div className="workbench-brand">
        <img src={brandIcon} alt="" className="brand-icon" />
        <span>AgentUI</span>
      </div>
      {onCloseSettings ? <div className="topbar-left settings-title">
        <button type="button" className="icon-btn" onClick={onCloseSettings} title="返回工作台 (Esc)" aria-label="返回工作台">
          <ArrowLeft size={16} />
        </button>
        <span className="topbar-title">设置</span>
      </div> : <div className="topbar-left">
        <details ref={detailsRef} className="title-menu" onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.stopPropagation()
            event.currentTarget.open = false
            event.currentTarget.querySelector('summary')?.focus()
          }
        }}>
          <summary title="会话详情" aria-label="会话详情">
            <span className="topbar-title">{thread?.title ?? '新建会话'}</span>
            <ChevronDown size={13} />
          </summary>
          <div className="title-card floating-card">
            <dl>
              <dt>工作目录</dt><dd className="title-card-path">{cwd ?? '请选择项目'}</dd>
              {thread?.worktreeBranch && <><dt>分支</dt><dd>{thread.worktreeBranch}</dd></>}
              <dt>模型</dt><dd>{thread?.modelId ?? '默认模型'}</dd>
              <dt>上下文</dt>
              <dd>{context ? `${context.tokens?.toLocaleString() ?? '?'} / ${context.contextWindow.toLocaleString()}${context.percent === null ? '' : ` (${context.percent}%)`}` : '暂无用量'}</dd>
              <dt>状态</dt><dd>{status}</dd>
            </dl>
            {thread && <div className="title-card-actions">
              <button type="button" className="btn-small" onClick={() => closeThen(onFork)}><GitFork size={13} /> 分叉 / 对比</button>
              <button type="button" className="btn-small" onClick={() => closeThen(onCompact)}><Minimize2 size={13} /> 压缩上下文</button>
            </div>}
          </div>
        </details>
        <span className={`harness-tag tag-${harness}`}>{HARNESS_LABELS[harness]}</span>
        <span className={`dot ${thread ? statusDotClass(thread.status) : ready ? 'dot-ready' : 'dot-idle'}`} title={status} role="img" aria-label={status} />
      </div>}
      <div className="topbar-right">
        <button type="button" className="icon-btn" title="独立浏览器窗口（登录状态与工作台隔离）" aria-label="独立浏览器窗口"
          onClick={onOpenBrowserWindow}>
          <AppWindow size={15} />
        </button>
        <button type="button" className="icon-btn palette-trigger" title="命令面板 (Ctrl+K)" aria-label="命令面板" onClick={onOpenPalette}>
          <Command size={15} />
        </button>
        {!onCloseSettings && <div className="workspace-tools" role="group" aria-label="工作区工具">
          {WORKSPACE_TOOLS.map(({ tab, label, icon: Icon }) => (
            <button key={tab} type="button" className="icon-btn" title={label} aria-label={label}
              aria-pressed={activeTool === tab || (tab === 'changes' && activeTool === 'worktrees') || (tab === 'terminal' && terminalDocked)}
              onClick={() => onToggleTool(tab)}>
              <Icon size={16} />
            </button>
          ))}
        </div>}
      </div>
    </header>
  )
}
