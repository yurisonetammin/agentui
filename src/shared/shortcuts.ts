export type GlobalShortcutAction =
  | 'new-thread'
  | 'focus-filter'
  | 'focus-composer'
  | 'toggle-diff'
  | 'open-worktrees'
  | 'switch-pi'
  | 'switch-omp'
  | 'switch-prime'
  | 'toggle-settings'
  | 'toggle-shortcuts'
  | 'escape'

export interface ShortcutKeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
}

export interface ShortcutHint {
  scope: 'global' | 'composer'
  keys: string[]
  description: string
}

export const SHORTCUT_HINTS: readonly ShortcutHint[] = [
  { scope: 'global', keys: ['Ctrl', 'N'], description: '在当前项目下新建对话' },
  { scope: 'global', keys: ['Ctrl', 'K'], description: '聚焦侧栏搜索过滤框' },
  { scope: 'global', keys: ['Ctrl', 'L'], description: '聚焦主指令输入框' },
  { scope: 'global', keys: ['Ctrl', '1 / 2 / 3'], description: '快速切换 Pi / OMP / Prime Agent' },
  { scope: 'global', keys: ['Ctrl', 'Shift', 'D'], description: '展开 / 收起右侧 Diff 审阅抽屉' },
  { scope: 'global', keys: ['Ctrl', 'Shift', 'W'], description: '打开右侧 Worktree 管理面板' },
  { scope: 'global', keys: ['Ctrl', ','], description: '打开 / 关闭引擎路径与环境设置' },
  { scope: 'global', keys: ['Ctrl', '/'], description: '打开 / 关闭快捷键速查面板' },
  { scope: 'global', keys: ['Esc'], description: '关闭当前弹窗；流式输出中则中止当前生成' },
  { scope: 'composer', keys: ['Enter'], description: '发送指令（运行中默认排队 Follow-up）' },
  { scope: 'composer', keys: ['Shift', 'Enter'], description: '输入框换行' },
  { scope: 'composer', keys: ['Ctrl', 'Enter'], description: '立即发送（运行中触发 Steer 打断并引导）' },
  { scope: 'composer', keys: ['↑'], description: '输入框为空时回填上一条发送的指令' },
]

export function matchGlobalShortcut(ev: ShortcutKeyEventLike): GlobalShortcutAction | null {
  if (ev.isComposing || ev.altKey) return null

  const primary = ev.ctrlKey || ev.metaKey
  const key = ev.key.toLowerCase()

  if (!primary && !ev.shiftKey && key === 'escape') {
    return 'escape'
  }

  if (!primary) return null

  if (ev.shiftKey) {
    if (key === 'd') return 'toggle-diff'
    if (key === 'w') return 'open-worktrees'
    return null
  }

  if (key === 'n') return 'new-thread'
  if (key === 'k') return 'focus-filter'
  if (key === 'l') return 'focus-composer'
  if (key === '1') return 'switch-pi'
  if (key === '2') return 'switch-omp'
  if (key === '3') return 'switch-prime'
  if (key === ',') return 'toggle-settings'
  if (key === '/' || key === '?') return 'toggle-shortcuts'

  return null
}
