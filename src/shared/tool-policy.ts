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
  /** Rule that produced the decision, when matched by fine-grained allow/ask/deny rules. */
  matchedRuleId?: string
}

export type PermissionRuleAction = 'allow' | 'ask' | 'deny'
export type PermissionRuleTarget = 'command' | 'tool' | 'path'

export interface ToolPermissionRule {
  id: string
  action: PermissionRuleAction
  target: PermissionRuleTarget
  /** Prefix or `*`-wildcard pattern (e.g. `npm test*`, `Bash`, `.env*`). */
  pattern: string
  note?: string
  createdAt: number
}

export const PERMISSION_RULE_ACTION_LABELS: Record<PermissionRuleAction, string> = {
  allow: '允许',
  ask: '询问',
  deny: '拒绝',
}

export const PERMISSION_RULE_TARGET_LABELS: Record<PermissionRuleTarget, string> = {
  command: '命令',
  tool: '工具',
  path: '路径',
}

export function isPermissionRuleAction(value: unknown): value is PermissionRuleAction {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

export function isPermissionRuleTarget(value: unknown): value is PermissionRuleTarget {
  return value === 'command' || value === 'tool' || value === 'path'
}

export function normalizePermissionRules(raw: unknown): ToolPermissionRule[] {
  if (!Array.isArray(raw)) return []
  const out: ToolPermissionRule[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (!isPermissionRuleAction(rec.action) || !isPermissionRuleTarget(rec.target)) continue
    const pattern = typeof rec.pattern === 'string' ? rec.pattern.trim() : ''
    if (!pattern || pattern.length > 200) continue
    const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `rule-${out.length + 1}`
    const dedupeKey = `${rec.action}:${rec.target}:${pattern.toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({
      id,
      action: rec.action,
      target: rec.target,
      pattern,
      note: typeof rec.note === 'string' && rec.note.trim() ? rec.note.trim().slice(0, 120) : undefined,
      createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : 0,
    })
  }
  return out.slice(0, 200)
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

const SHELL_CHAIN_RE = /[>;`\r\n|]|&&|\|\||\$\(|<\(/

export function extractToolName(title: string): string {
  // e.g. "Claude 请求执行 Bash" / "Codex 请求执行命令" / native "执行工具 write_file"
  const m = title.match(/(?:执行|运行|工具|tool)\s*([A-Za-z_][\w./-]*)/i)
  return m?.[1] ?? title
}

/** Extract a target file path from JSON tool previews or plain-text approval messages. */
export function extractTargetPath(title: string, message?: string): string | null {
  if (message) {
    const text = message.trim()
    if (text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>
          for (const key of ['file_path', 'filePath', 'path', 'target_file', 'filename']) {
            if (typeof rec[key] === 'string' && rec[key].trim()) return rec[key].trim()
          }
        }
      } catch {
        // truncated JSON preview — fall back to regex below
      }
      const m = text.match(/"(?:file_path|filePath|path|target_file)"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (m?.[1]) {
        try {
          return JSON.parse(`"${m[1]}"`) as string
        } catch {
          return m[1]
        }
      }
    }
    // Codex file change approval lists paths on lines after the header
    if (/修改工作区文件|文件变更/i.test(title) || /修改工作区文件/i.test(text)) {
      const lines = text.split(/\r?\n/).slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('原因') && !l.startsWith('授权目录'))
      if (lines[0]) return lines[0]
    }
  }
  return null
}

const MULTI_WORD_RUNNERS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'cargo', 'go', 'git', 'dotnet', 'uv', 'poetry', 'pip', 'docker', 'kubectl',
])

/**
 * Derive a safe, human-readable command prefix pattern (e.g. `npm test*`, `cargo check*`)
 * for "Allow in this session / project" quick actions.
 * Returns null for chained/redirected/multiline commands so compound pipelines are never auto-whitelisted.
 */
export function deriveCommandPrefixPattern(command: string | null | undefined): string | null {
  if (!command) return null
  const trimmed = command.trim()
  if (!trimmed || SHELL_CHAIN_RE.test(trimmed)) return null
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const bin = firstWord(tokens[0]).toLowerCase()
  if (!bin || bin.startsWith('-')) return null

  if (MULTI_WORD_RUNNERS.has(bin) && tokens.length >= 2 && !tokens[1].startsWith('-')) {
    if ((bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') && tokens[1].toLowerCase() === 'run' && tokens[2] && !tokens[2].startsWith('-')) {
      return `${tokens[0]} ${tokens[1]} ${tokens[2]}*`
    }
    return `${tokens[0]} ${tokens[1]}*`
  }
  return `${tokens[0]}*`
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchesCommandPattern(pattern: string, command: string): boolean {
  const cleanPat = pattern.trim()
  const cleanCmd = command.trim()
  if (!cleanPat || !cleanCmd) return false
  // Simple trailing-wildcard prefix (`npm test*` or `npm test`): require word boundary after prefix
  // so `npm test*` matches `npm test` and `npm test --watch`, never `npm testing-evil`.
  if (!cleanPat.slice(0, -1).includes('*')) {
    const base = cleanPat.endsWith('*') ? cleanPat.slice(0, -1).trimEnd() : cleanPat
    if (!base) return true
    const lowerBase = base.toLowerCase()
    const lowerCmd = cleanCmd.toLowerCase()
    return lowerCmd === lowerBase || lowerCmd.startsWith(`${lowerBase} `)
  }
  return globToRegExp(cleanPat).test(cleanCmd)
}

function matchesRule(
  rule: ToolPermissionRule,
  ctx: { command: string | null; toolName: string; targetPath: string | null },
): boolean {
  const pat = rule.pattern.trim()
  if (!pat) return false

  if (rule.target === 'command') {
    if (!ctx.command) return false
    // Security invariant: `allow` rules for commands never match chained/piped/redirected commands.
    if (rule.action === 'allow' && SHELL_CHAIN_RE.test(ctx.command)) return false
    return matchesCommandPattern(pat, ctx.command)
  }

  if (rule.target === 'tool') {
    if (!ctx.toolName) return false
    return globToRegExp(pat).test(ctx.toolName)
  }

  if (rule.target === 'path') {
    if (!ctx.targetPath) return false
    const normPath = ctx.targetPath.replace(/\\/g, '/')
    const normPat = pat.replace(/\\/g, '/')
    const baseName = normPath.split('/').pop() ?? normPath
    if (normPat.includes('*')) {
      return globToRegExp(normPat).test(normPath) || (!normPat.includes('/') && globToRegExp(normPat).test(baseName))
    }
    const lowerPath = normPath.toLowerCase()
    const lowerPat = normPat.toLowerCase().replace(/\/+$/, '')
    return (
      lowerPath === lowerPat ||
      lowerPath.startsWith(`${lowerPat}/`) ||
      lowerPath.endsWith(`/${lowerPat}`) ||
      baseName.toLowerCase() === lowerPat
    )
  }

  return false
}

/**
 * Evaluate fine-grained allow/ask/deny rules in strict security precedence:
 * `deny` > `ask` > `allow`.
 */
export function matchPermissionRules(
  rules: readonly ToolPermissionRule[],
  req: { title: string; message?: string; command?: string | null },
): ToolPermissionRule | null {
  if (rules.length === 0) return null
  const command = req.command?.trim() ? req.command : extractCommand(req.title, req.message)
  const toolName = extractToolName(req.title)
  const targetPath = extractTargetPath(req.title, req.message)
  const ctx = { command, toolName, targetPath }

  for (const action of ['deny', 'ask', 'allow'] as const) {
    for (const rule of rules) {
      if (rule.action !== action) continue
      if (matchesRule(rule, ctx)) return rule
    }
  }
  return null
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

export function decideApproval(
  preset: TrustPreset,
  assessment: ToolRiskAssessment,
  matchedRule?: ToolPermissionRule | null,
): ApprovalDecision {
  // Unbreakable invariant: high-risk requests can be explicitly denied (or blocked under readonly),
  // otherwise ALWAYS require human confirmation even under auto mode or allow rules.
  if (assessment.level === 'high') {
    if (matchedRule?.action === 'deny') {
      return { action: 'deny', reason: `命中拒绝规则「${matchedRule.pattern}」`, matchedRuleId: matchedRule.id }
    }
    if (preset === 'readonly') {
      return {
        action: 'deny',
        reason: `只读观察模式已自动拒绝${assessment.reasons.length > 0 ? `（${assessment.reasons.join('、')}）` : ''}`,
      }
    }
    return {
      action: 'ask',
      reason: `高风险操作必须人工确认：${assessment.reasons.join('、')}`,
    }
  }

  if (matchedRule) {
    if (matchedRule.action === 'deny') {
      return { action: 'deny', reason: `命中拒绝规则「${matchedRule.pattern}」`, matchedRuleId: matchedRule.id }
    }
    if (matchedRule.action === 'ask') {
      return { action: 'ask', reason: `命中人工确认规则「${matchedRule.pattern}」`, matchedRuleId: matchedRule.id }
    }
    if (matchedRule.action === 'allow') {
      // Readonly preset acts as a hard write-block ceiling even if project allow rules exist.
      if (preset !== 'readonly' || assessment.readOnly || assessment.level === 'safe') {
        return { action: 'allow', reason: `命中允许规则「${matchedRule.pattern}」`, matchedRuleId: matchedRule.id }
      }
    }
  }

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
