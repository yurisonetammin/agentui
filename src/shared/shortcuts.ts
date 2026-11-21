import type { ConversationSettings } from './settings'

export type GlobalShortcutAction =
  | 'new-thread'
  | 'open-palette'
  | 'focus-composer'
  | 'toggle-diff'
  | 'open-worktrees'
  | 'open-files'
  | 'open-terminal'
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
  { scope: 'global', keys: ['Ctrl', 'K'], description: '打开命令面板，搜索会话、引擎、工作区工具和设置' },
  { scope: 'global', keys: ['Ctrl', 'L'], description: '聚焦主指令输入框' },
  { scope: 'global', keys: ['Ctrl', '1 / 2 / 3'], description: '快速切换 Pi / OMP / Prime Agent' },
  { scope: 'global', keys: ['Ctrl', 'Shift', 'D'], description: '展开 / 收起右侧工作区抽屉（变更审阅）' },
  { scope: 'global', keys: ['Ctrl', 'Shift', 'W'], description: '打开右侧 Worktree 管理面板' },
  { scope: 'global', keys: ['Ctrl', 'Shift', 'E'], description: '打开右侧工作区文件树与只读预览' },
  { scope: 'global', keys: ['Ctrl', 'Shift', 'T'], description: '打开内嵌终端' },
  { scope: 'global', keys: ['Ctrl', ','], description: '打开 / 关闭设置' },
  { scope: 'global', keys: ['Ctrl', '/'], description: '打开 / 关闭快捷键速查面板' },
  { scope: 'global', keys: ['Esc'], description: '关闭当前弹窗；流式输出中则中止当前生成' },
  { scope: 'composer', keys: ['Enter'], description: '发送指令（运行中默认排队 Follow-up）' },
  { scope: 'composer', keys: ['Shift', 'Enter'], description: '输入框换行' },
  { scope: 'composer', keys: ['Ctrl', 'Enter'], description: '立即发送（运行中触发 Steer 打断并引导）' },
  { scope: 'composer', keys: ['@'], description: '工作区文件模糊引用补全（Tab / Enter 选中）' },
  { scope: 'composer', keys: ['/'], description: '斜杠命令与引擎 Skill/模板补全' },
  { scope: 'composer', keys: ['Ctrl', 'V'], description: '直接粘贴剪贴板截图作为图片附件' },
  { scope: 'composer', keys: ['↑'], description: '输入框为空时回填上一条发送的指令' },
]

export function runningMessageAction(enterWhileRunning: ConversationSettings['enterWhileRunning'], modified: boolean) {
  return modified ? (enterWhileRunning === 'steer' ? 'followUp' : 'steer') : enterWhileRunning
}

export function shortcutHints(enterWhileRunning: ConversationSettings['enterWhileRunning']): readonly ShortcutHint[] {
  return SHORTCUT_HINTS.map((hint) => {
    if (hint.scope !== 'composer') return hint
    const key = hint.keys.join('+')
    if (key !== 'Enter' && key !== 'Ctrl+Enter') return hint
    const action = runningMessageAction(enterWhileRunning, key === 'Ctrl+Enter')
    return { ...hint, description: `空闲时发送 · 运行中${action === 'steer' ? '引导（Steer）' : '排队（Follow-up）'}` }
  })
}

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
    if (key === 'e') return 'open-files'
    if (key === 't') return 'open-terminal'
    return null
  }

  if (key === 'n') return 'new-thread'
  if (key === 'k') return 'open-palette'
  if (key === 'l') return 'focus-composer'
  if (key === '1') return 'switch-pi'
  if (key === '2') return 'switch-omp'
  if (key === '3') return 'switch-prime'
  if (key === ',') return 'toggle-settings'
  if (key === '/' || key === '?') return 'toggle-shortcuts'

  return null
}
