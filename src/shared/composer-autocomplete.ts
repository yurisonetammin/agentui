import { THINKING_LEVELS, type SlashCommandDescriptor, type ThinkingLevel } from './types'

export interface ComposerTrigger {
  kind: 'file' | 'slash'
  query: string
  start: number
  end: number
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: 'compact', description: '压缩当前会话上下文，节省 Token', source: 'builtin' },
  { name: 'fork', description: '打开会话分叉树与多方案对比面板', source: 'builtin' },
  { name: 'clone', description: '从当前最新状态克隆一个并行对比分支', source: 'builtin' },
  { name: 'new', description: '在当前项目下新建对话', source: 'builtin' },
  { name: 'thinking', description: '设置推理强度档位', source: 'builtin', argsHint: 'off|low|medium|high|max' },
  { name: 'diff', description: '打开右侧 Git Diff 变更审阅面板', source: 'builtin' },
  { name: 'worktree', description: '打开右侧 Git Worktree 隔离工作区面板', source: 'builtin' },
  { name: 'reconnect', description: '重新连接当前 Agent 子进程', source: 'builtin' },
  { name: 'retry', description: '重连并重试上一条发送的指令', source: 'builtin' },
  { name: 'shortcuts', description: '打开快捷键速查弹窗', source: 'builtin' },
  { name: 'settings', description: '打开引擎路径与环境设置', source: 'builtin' },
]

export type ParsedBuiltinSlash =
  | { type: 'compact' }
  | { type: 'fork' }
  | { type: 'clone' }
  | { type: 'new' }
  | { type: 'diff' }
  | { type: 'worktree' }
  | { type: 'reconnect' }
  | { type: 'retry' }
  | { type: 'shortcuts' }
  | { type: 'settings' }
  | { type: 'thinking'; level: ThinkingLevel }

export function parseBuiltinSlashCommand(rawText: string): ParsedBuiltinSlash | null {
  const trimmed = rawText.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const cmd = parts[0].toLowerCase()
  const arg = parts[1]?.toLowerCase()

  if (cmd === 'compact' && parts.length === 1) return { type: 'compact' }
  if (cmd === 'fork' && parts.length === 1) return { type: 'fork' }
  if (cmd === 'clone' && parts.length === 1) return { type: 'clone' }
  if (cmd === 'new' && parts.length === 1) return { type: 'new' }
  if (cmd === 'diff' && parts.length === 1) return { type: 'diff' }
  if ((cmd === 'worktree' || cmd === 'wt') && parts.length === 1) return { type: 'worktree' }
  if (cmd === 'reconnect' && parts.length === 1) return { type: 'reconnect' }
  if (cmd === 'retry' && parts.length === 1) return { type: 'retry' }
  if (cmd === 'shortcuts' && parts.length === 1) return { type: 'shortcuts' }
  if (cmd === 'settings' && parts.length === 1) return { type: 'settings' }
  if (cmd === 'thinking' && arg && (THINKING_LEVELS as readonly string[]).includes(arg)) {
    return { type: 'thinking', level: arg as ThinkingLevel }
  }
  return null
}

/**
 * Detects an active `@file` or leading `/command` autocomplete trigger at `cursorPos`.
 */
export function detectComposerTrigger(text: string, cursorPos: number): ComposerTrigger | null {
  const clamped = Math.max(0, Math.min(cursorPos, text.length))
  const before = text.slice(0, clamped)

  // Leading /slash command (only at the start of the prompt, before any whitespace after command token)
  const slashMatch = before.match(/^(\s*)\/([^\s]*)$/)
  if (slashMatch) {
    const leadingSpaces = slashMatch[1].length
    return {
      kind: 'slash',
      query: slashMatch[2],
      start: leadingSpaces,
      end: clamped,
    }
  }

  // @file mention (must be at start of string or preceded by whitespace, avoiding emails like a@b.com)
  const atMatch = before.match(/(^|[\s([{"'])@([^\s@]*)$/)
  if (atMatch) {
    const query = atMatch[2]
    const start = clamped - query.length - 1
    return {
      kind: 'file',
      query,
      start,
      end: clamped,
    }
  }

  return null
}

export function applyTriggerInsertion(
  text: string,
  trigger: ComposerTrigger,
  replacement: string,
): { nextText: string; nextCursor: number } {
  const prefix = text.slice(0, trigger.start)
  const suffix = text.slice(trigger.end)
  const needsSpace = !replacement.endsWith(' ') && (suffix.length === 0 || !/^\s/.test(suffix))
  const inserted = needsSpace ? `${replacement} ` : replacement
  const nextText = `${prefix}${inserted}${suffix}`
  return {
    nextText,
    nextCursor: prefix.length + inserted.length,
  }
}

export function fuzzyScorePath(filePath: string, query: string): number {
  const q = query.trim().toLowerCase()
  const norm = filePath.replace(/\\/g, '/')
  if (!q) return 1000 - Math.min(norm.length, 500)

  const lower = norm.toLowerCase()
  const slashIdx = lower.lastIndexOf('/')
  const base = slashIdx === -1 ? lower : lower.slice(slashIdx + 1)
  const dotIdx = base.lastIndexOf('.')
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base

  if (base === q) return 5000 - norm.length
  if (stem === q) return 4600 - norm.length
  if (base.startsWith(q)) return 4000 - base.length * 10 - norm.length
  if (lower.startsWith(q)) return 3500 - norm.length
  const baseContains = base.indexOf(q)
  if (baseContains !== -1) return 3000 - baseContains * 5 - base.length * 2 - norm.length
  const pathContains = lower.indexOf(q)
  if (pathContains !== -1) return 2200 - pathContains * 2 - norm.length

  // Subsequence fuzzy match
  let qi = 0
  let consecutive = 0
  let bonus = 0
  for (let i = 0; i < lower.length && qi < q.length; i += 1) {
    if (lower[i] === q[qi]) {
      qi += 1
      consecutive += 1
      bonus += consecutive * 8
      if (i === 0 || lower[i - 1] === '/' || lower[i - 1] === '-' || lower[i - 1] === '_' || lower[i - 1] === '.') {
        bonus += 15
      }
    } else {
      consecutive = 0
    }
  }
  if (qi < q.length) return -1
  return 1000 + bonus - norm.length
}

export function fuzzyFilterPaths(paths: readonly string[], query: string, limit = 40): string[] {
  const scored: Array<{ path: string; score: number }> = []
  for (const p of paths) {
    const score = fuzzyScorePath(p, query)
    if (score >= 0) scored.push({ path: p, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map((item) => item.path)
}

export function filterSlashCommands(
  commands: readonly SlashCommandDescriptor[],
  query: string,
): SlashCommandDescriptor[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...commands]
  return commands
    .filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        (cmd.description?.toLowerCase().includes(q) ?? false) ||
        cmd.source.toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1
      if (aStarts !== bStarts) return aStarts - bStarts
      return a.name.localeCompare(b.name)
    })
}
