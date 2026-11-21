/**
 * Project trust presets & tool-permission policy (pure functions).
 *
 * Enforcement happens in RuntimeManager at the canonical approval boundary
 * (`extension_ui_request` confirm/select). Engines that execute tools without
 * asking cannot be intercepted here — the policy is best-effort at the
 * approval layer, and high-risk operations always fall back to a human prompt
 * even in auto mode.
 */

export type TrustPreset = 'readonly' | 'approval' | 'auto'

export const TRUST_PRESETS: readonly TrustPreset[] = ['readonly', 'approval', 'auto']

export const TRUST_PRESET_LABELS: Record<TrustPreset, string> = {
  readonly: '只读观察',
  approval: '写操作需审批',
  auto: '自动模式',
}

export const TRUST_PRESET_DESCRIPTIONS: Record<TrustPreset, string> = {
  readonly: '在审批请求中允许读取与检索，自动拒绝写入或非只读命令。',
  approval: '工具审批请求由你在时间线中确认，高风险命令会醒目标出。',
  auto: '常规操作自动批准；命中高风险规则的操作仍需要人工确认。',
}

export function isTrustPreset(value: unknown): value is TrustPreset {
  return value === 'readonly' || value === 'approval' || value === 'auto'
}

export type ToolRiskLevel = 'safe' | 'write' | 'high'

export interface ToolRiskAssessment {
  level: ToolRiskLevel
  reasons: string[]
  /** Extracted shell command when the request carries one. */
  command: string | null
  /** True when the operation is clearly read-only (safe under the readonly preset). */
  readOnly: boolean
}

export interface ApprovalDecision {
  action: 'allow' | 'deny' | 'ask'
  reason: string
}

interface RiskRule {
  pattern: RegExp
  label: string
}

const HIGH_RISK_RULES: RiskRule[] = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\b/i, label: '递归/强制删除 (rm -rf)' },
  { pattern: /\brm\s+.*\s\/(\s|$)/i, label: '删除根目录' },
  { pattern: /\bdel\s+\/[a-z]*[fsq]/i, label: 'Windows 强制/递归删除 (del /f /s /q)' },
  { pattern: /\brmdir\s+\/s/i, label: 'Windows 递归删除目录 (rmdir /s)' },
  { pattern: /Remove-Item[^\n]*-Recurse[^\n]*-Force|Remove-Item[^\n]*-Force[^\n]*-Recurse/i, label: 'PowerShell 递归强制删除' },
  { pattern: /\bformat\s+[a-z]:/i, label: '格式化磁盘' },
  { pattern: /\bdiskpart\b/i, label: '磁盘分区操作 (diskpart)' },
  { pattern: /\bmkfs(\.\w+)?\b/i, label: '创建文件系统 (mkfs)' },
  { pattern: /\bdd\s+[^\n]*of=\/dev\//i, label: '写入块设备 (dd of=/dev/…)' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/i, label: '重定向覆盖磁盘设备' },
  { pattern: /\bshutdown\b|\breboot\b/i, label: '关机 / 重启' },
  { pattern: /\breg\s+delete\b/i, label: '删除注册表项' },
  { pattern: /\bgit\s+push\b[^\n]*\s(-f\b|--force\b|--force-with-lease\b)/i, label: '强制推送 (git push --force)' },
  { pattern: /\brm\s+[^\n]*--(recursive|force)\b/i, label: '递归/强制删除 (rm --recursive/--force)' },
  { pattern: /\b(rd|rmdir)\s+\/s\b/i, label: 'Windows 递归删除目录 (rd /s)' },
  { pattern: /\b(Remove-Item|ri|del)\b[^\n]*\s-(Recurse|r)\b/i, label: 'PowerShell 递归删除' },
  { pattern: /\bgit\s+branch\s+[^\n]*-[dD]\b/, label: '删除分支 (git branch -d/-D)' },
  { pattern: /\bgit\s+(checkout\s+--\s+\.|restore\s+\.)/i, label: '丢弃全部工作区改动' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, label: '硬重置丢弃改动 (git reset --hard)' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, label: '强制清理未跟踪文件 (git clean -f)' },
  { pattern: /(curl|wget)\s+[^|\n]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/i, label: '下载脚本直接执行 (curl | sh)' },
  { pattern: /(iwr|Invoke-WebRequest)[^|\n]*\|\s*(iex|Invoke-Expression)/i, label: '下载脚本直接执行 (iwr | iex)' },
  { pattern: /\bchmod\s+(-[a-z]+\s+)*777\s+\//i, label: '全局放开权限 (chmod 777 /)' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, label: '删库 / 清表 SQL' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, label: 'Fork 炸弹' },
  { pattern: /\bfind\s+[^\n]*(-delete|-exec\s+rm)/i, label: 'find 批量删除' },
]

const READ_ONLY_FIRST_WORDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'pwd', 'echo',
  'which', 'where', 'whereis', 'grep', 'rg', 'ag', 'fd', 'tree', 'stat', 'file',
  'wc', 'du', 'df', 'whoami', 'hostname', 'date', 'printenv', 'Get-ChildItem',
  'Get-Content', 'Get-Location', 'Select-String', 'Test-Path',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'blame', 'remote', 'tag', 'ls-files', 'rev-parse', 'describe', 'shortlog',
])

const READ_TOOL_NAME = /^(read|glob|grep|list|search|view|cat|ls|find|fetch|web_search|websearch)/i
const WRITE_TOOL_NAME = /(write|edit|delete|remove|bash|shell|exec|run|terminal|apply_patch|patch|create|move|rename|kill|notebook)/i

function firstWord(command: string): string {
  const trimmed = command.trim().replace(/^["']|["']$/g, '')
  const word = trimmed.split(/\s+/)[0] ?? ''
  return word.replace(/\.exe$/i, '').replace(/^.*[\\/]/, '')
}

/** Conservative read-only shell command classification (used by the readonly preset). */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  // Chained / redirected commands may hide writes; only accept a single simple pipeline of reads.
  if (/[>;`\r\n]|&&|\|\||\$\(|<\(/.test(trimmed)) return false
  const segments = trimmed.split('|').map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return false
  for (const seg of segments) {
    const word = firstWord(seg)
    if (word.toLowerCase() === 'git') {
      const parts = seg.split(/\s+/)
      const sub = parts[1]?.toLowerCase() ?? ''
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false
      const rest = parts.slice(2)
      // branch/tag/remote are read-only only when merely listing.
      if (
        (sub === 'branch' || sub === 'tag') &&
        rest.some((a) => !/^--?(list|l|a|r|v|vv|all|remotes|verbose|merged|no-merged|contains|show-current)$/i.test(a))
      ) {
        return false
      }
      if (sub === 'remote' && rest.some((a) => !/^(-v|--verbose)$/i.test(a))) return false
      continue
    }
    if (word.toLowerCase() === 'find') {
      if (/-delete|-exec|-execdir|-ok\b|-okdir|-fls|-fprint|-fprintf/i.test(seg)) return false
      continue
    }
    if (word.toLowerCase() === 'npm' || word.toLowerCase() === 'pnpm' || word.toLowerCase() === 'yarn') {
      const sub = seg.split(/\s+/)[1]?.toLowerCase() ?? ''
      if (!['ls', 'list', 'view', 'outdated', 'info'].includes(sub)) return false
      continue
    }
    if (!READ_ONLY_FIRST_WORDS.has(word) && !READ_ONLY_FIRST_WORDS.has(word.toLowerCase())) return false
  }
  return true
}

function extractCommand(title: string, message?: string): string | null {
  if (!message) return null
  const text = message.trim()
  // Claude bridge sends a JSON preview of the tool input.
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>
        for (const key of ['command', 'cmd', 'script', 'commandLine']) {
          if (typeof rec[key] === 'string' && rec[key].trim()) return rec[key] as string
        }
      }
    } catch {
      // truncated preview (>2000 chars) — fall back to regex below
    }
    const m = text.match(/"(?:command|cmd|script)"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m?.[1]) {
      try {
        return JSON.parse(`"${m[1]}"`) as string
      } catch {
        return m[1]
      }
    }
  }
  // Codex bridge sends the raw command as the first line.
  if (/codex.*执行命令/i.test(title)) {
    const line = text.split(/\r?\n/)[0]?.trim()
    if (line && !line.startsWith('原因')) return line
  }
  return null
}

function extractToolName(title: string): string {
  // e.g. "Claude 请求执行 Bash" / "Codex 请求执行命令" / native "执行工具 write_file"
  const m = title.match(/(?:执行|运行|工具|tool)\s*([A-Za-z_][\w./-]*)/i)
  return m?.[1] ?? title
}

export function assessToolRequest(req: { title: string; message?: string; command?: string }): ToolRiskAssessment {
  const command = req.command?.trim() ? req.command : extractCommand(req.title, req.message)
  const haystack = `${req.title}\n${command ?? ''}\n${req.message ?? ''}`
  const reasons: string[] = []
  for (const rule of HIGH_RISK_RULES) {
    if (rule.pattern.test(haystack)) reasons.push(rule.label)
  }
  if (reasons.length > 0) {
    return { level: 'high', reasons, command, readOnly: false }
  }
  if (command) {
    const readOnly = isReadOnlyCommand(command)
    return { level: readOnly ? 'safe' : 'write', reasons: readOnly ? [] : ['Shell 命令执行'], command, readOnly }
  }
  const toolName = extractToolName(req.title)
  if (READ_TOOL_NAME.test(toolName)) {
    return { level: 'safe', reasons: [], command: null, readOnly: true }
  }
  if (WRITE_TOOL_NAME.test(toolName)) {
    return { level: 'write', reasons: [`写入/执行类工具 ${toolName}`], command: null, readOnly: false }
  }
  // Unknown operations default to write-level: they need approval under the default preset.
  return { level: 'write', reasons: ['未识别的操作类型，按写操作对待'], command: null, readOnly: false }
}

export function decideApproval(preset: TrustPreset, assessment: ToolRiskAssessment): ApprovalDecision {
  if (preset === 'readonly') {
    if (assessment.readOnly || assessment.level === 'safe') {
      return { action: 'allow', reason: '只读操作，已自动放行' }
    }
    return {
      action: 'deny',
      reason: `只读观察模式已自动拒绝${assessment.reasons.length > 0 ? `（${assessment.reasons.join('、')}）` : ''}`,
    }
  }
  if (preset === 'auto') {
    if (assessment.level === 'high') {
      return { action: 'ask', reason: `自动模式下高风险操作仍需人工确认：${assessment.reasons.join('、')}` }
    }
    return { action: 'allow', reason: '自动模式已批准常规操作' }
  }
  return { action: 'ask', reason: '写操作需审批' }
}

const ALLOW_OPTION = /allow|approve|accept|yes|proceed|允许|同意|确认|继续/i
const DENY_OPTION = /reject|deny|decline|no\b|cancel|拒绝|取消|不允许|禁止/i

/** Pick an allow/deny option for select-style permission prompts (e.g. ACP). */
export function pickSelectOption(options: readonly string[], allow: boolean): string | undefined {
  if (options.length === 0) return undefined
  const pattern = allow ? ALLOW_OPTION : DENY_OPTION
  const persistent = /always|永久|始终|总是|don'?t ask|\ball\b/i
  const once = options.filter((o) => pattern.test(o) && !persistent.test(o))
  if (once.length > 0) return once[0]
  // Never fall back to a persistent grant or an arbitrary first option when allowing.
  if (allow) return undefined
  return options.find((o) => pattern.test(o))
}
