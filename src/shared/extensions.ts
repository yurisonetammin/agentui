/**
 * 设置页「MCP / 插件 / 技能 / 使用情况 / 浏览器」五个入口的共享类型与纯函数。
 *
 * MCP、插件、技能共用 Pi / OMP / Prime 引擎切换器；本模块只包含
 * 类型定义、CLI 输出解析与聚合逻辑，进程/文件访问在主进程 services 中。
 */
import type { ContextUsageInfo, HarnessId, TokenUsage } from './types'
import { resolveMcpShadowing, type McpTransport, type RawMcpEntry } from './mcp-config'

export type ExtensionEngine = 'pi' | 'omp' | 'prime'

export const EXTENSION_ENGINES: readonly ExtensionEngine[] = ['pi', 'omp', 'prime']

export const EXTENSION_ENGINE_LABELS: Record<ExtensionEngine, string> = {
  pi: 'Pi',
  omp: 'OMP',
  prime: 'Prime Agent',
}

export function isExtensionEngine(value: unknown): value is ExtensionEngine {
  return value === 'pi' || value === 'omp' || value === 'prime'
}

/** Feature gates per engine (grounded in real CLI probing, see docs/STATUS.md). */
export interface ExtensionEngineCapabilities {
  mcp: { discover: boolean; manageUser: boolean; manageProject: boolean; liveCheck: boolean; note?: string }
  packages: { list: boolean; install: boolean; remove: boolean; update: boolean; projectScope: boolean; note?: string }
  skills: { discover: boolean; note?: string }
  usage: { report: boolean; globalStats: boolean; accountQuota: boolean; note?: string }
}

export const EXTENSION_ENGINE_CAPABILITIES: Record<ExtensionEngine, ExtensionEngineCapabilities> = {
  pi: {
    mcp: { discover: true, manageUser: true, manageProject: true, liveCheck: true, note: '经 pi mcp 管理；项目级 .pi/mcp.json 仅在 Pi 信任该项目后读取。' },
    packages: { list: true, install: true, remove: true, update: true, projectScope: true, note: '经 pi install/remove/list 管理（用户级 ~/.pi/agent/settings.json 或项目 .pi/settings.json）。' },
    skills: { discover: true, note: '扫描引擎 skills 目录与项目 .pi/skills；技能在会话启动时加载。' },
    usage: { report: true, globalStats: false, accountQuota: false, note: '从会话记录汇总；账户额度未提供。' },
  },
  omp: {
    mcp: { discover: true, manageUser: true, manageProject: true, liveCheck: false, note: '直接读写 OMP 自有配置（.omp/mcp.json、用户级 mcp.json），并展示第三方发现来源的覆盖关系；同名配置第一次定义获胜。' },
    packages: { list: true, install: true, remove: true, update: true, projectScope: true, note: '经 omp plugin 管理（npm 与 marketplace 两类）。' },
    skills: { discover: true, note: '经 omp skill list 发现（含其他引擎目录来源，如 claude:user）。' },
    usage: { report: true, globalStats: true, accountQuota: true, note: 'omp stats --json 提供引擎全局统计；omp usage --json 提供账户额度。' },
  },
  prime: {
    mcp: { discover: true, manageUser: true, manageProject: false, liveCheck: false, note: '经 prime-agent mcp 管理用户级服务器；服务器通过 Python 运行环境供引擎调用，运行状态以会话反馈为准。' },
    packages: { list: true, install: true, remove: true, update: true, projectScope: false, note: 'Prime Agent 的技能、提示与主题包安装在用户级配置中。' },
    skills: { discover: true, note: '区分项目 Markdown 指令与用户级技能目录；旧版 Prime TS 的扩展能力不可用。' },
    usage: { report: true, globalStats: true, accountQuota: false, note: '优先读取 prime-agent sessions --json；缺失的 Token、缓存或费用标为「未提供」。' },
  },
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpConfigFileInfo {
  path: string
  /** 展示用来源名（用户级 mcp.json / 项目 .omp/mcp.json / Claude Code ...）。 */
  label: string
  scope: 'user' | 'project' | 'third-party'
  kind: 'json' | 'toml'
  exists: boolean
  /** AgentUI 会把编辑写入该文件。 */
  writable: boolean
  note?: string
}

export type { McpTransport }

export interface McpServerEntry extends RawMcpEntry {
  shadowedBy?: string
  /** pi mcp list --json 的实况（仅 Pi，点击「检查状态」后出现）。 */
  live?: { state?: string; toolCount?: number; error?: string }
}

export interface McpSessionState {
  /** 当前项目 + 引擎是否有运行中的会话。 */
  hasLiveSession: boolean
  /** 会话启动后配置文件是否被修改过（需要空闲后重连生效）。 */
  configChangedAfterStart: boolean | null
  detail: string
}

export interface McpEngineSnapshot {
  engine: ExtensionEngine
  engineReady: boolean
  engineVersion: string | null
  projectPath: string | null
  configFiles: McpConfigFileInfo[]
  servers: McpServerEntry[]
  sessionState: McpSessionState
  errors: string[]
  fetchedAt: number
}

export interface McpAddInput {
  engine: ExtensionEngine
  scope: 'user' | 'project'
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Array<{ key: string; value: string }>
  url?: string
  headers?: Array<{ key: string; value: string }>
  bearerTokenEnvVar?: string
  description?: string
}

/** Parse `pi mcp list --json` (`{servers: [...], errors: [...]}`). Defensive: shape may evolve. */
export function parsePiMcpListJson(raw: string): { live: Record<string, { state?: string; toolCount?: number; error?: string }>; errors: string[] } {
  const live: Record<string, { state?: string; toolCount?: number; error?: string }> = {}
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { live, errors: [raw.slice(0, 300)] }
  }
  if (!parsed || typeof parsed !== 'object') return { live, errors }
  const obj = parsed as Record<string, unknown>
  const servers = Array.isArray(obj.servers) ? obj.servers : []
  for (const item of servers) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name : null
    if (!name) continue
    const tools = Array.isArray(rec.tools) ? rec.tools.length : typeof rec.toolCount === 'number' ? rec.toolCount : undefined
    const state = typeof rec.state === 'string' ? rec.state : typeof rec.status === 'string' ? rec.status : undefined
    const error = typeof rec.error === 'string' ? rec.error : undefined
    live[name] = { state, toolCount: tools, error }
  }
  for (const item of Array.isArray(obj.errors) ? obj.errors : []) {
    if (typeof item === 'string') errors.push(item)
    else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const name = typeof rec.name === 'string' ? rec.name : 'unknown'
      const message = typeof rec.error === 'string' ? rec.error : typeof rec.message === 'string' ? rec.message : ''
      if (message) errors.push(`${name}: ${message}`)
    }
  }
  return { live, errors }
}

// ---------------------------------------------------------------------------
// 插件 / 包
// ---------------------------------------------------------------------------

export interface EnginePackageEntry {
  id: string
  name: string
  version?: string
  scope: 'user' | 'project' | 'local'
  manager: 'npm' | 'marketplace' | 'git' | 'path' | 'unknown'
  description?: string
  path?: string
  /** 包内可执行资源摘要（扩展/技能/模板/主题），能拿到时展示。 */
  resources?: string[]
}

export interface EnginePackageSnapshot {
  engine: ExtensionEngine
  engineReady: boolean
  engineVersion: string | null
  projectPath: string | null
  packages: EnginePackageEntry[]
  errors: string[]
  /** 解析失败时的原始输出，供界面降级展示。 */
  raw?: string
  fetchedAt: number
}

/** Parse `omp plugin list --json` (`{npm: [...], marketplace: [...]}`). */
export function parseOmpPluginListJson(raw: string): { packages: EnginePackageEntry[]; errors: string[] } {
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { packages: [], errors: [raw.slice(0, 300)] }
  }
  if (!parsed || typeof parsed !== 'object') return { packages: [], errors }
  const obj = parsed as Record<string, unknown>
  const packages: EnginePackageEntry[] = []
  const collect = (list: unknown, manager: EnginePackageEntry['manager']) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const name = typeof rec.name === 'string' ? rec.name : typeof rec.id === 'string' ? rec.id : null
      if (!name) continue
      packages.push({
        id: `${manager}:${name}`,
        name,
        version: typeof rec.version === 'string' ? rec.version : undefined,
        scope: rec.scope === 'project' ? 'project' : rec.local === true ? 'local' : 'user',
        manager,
        description: typeof rec.description === 'string' ? rec.description : undefined,
        path: typeof rec.path === 'string' ? rec.path : typeof rec.dir === 'string' ? rec.dir : undefined,
        resources: Array.isArray(rec.features)
          ? rec.features.filter((f): f is string => typeof f === 'string')
          : undefined,
      })
    }
  }
  collect(obj.npm, 'npm')
  collect(obj.marketplace, 'marketplace')
  return { packages, errors }
}

/** Parse plain-text package lists (`pi list`, `prime-agent package list`). */
export function parsePlainPackageList(raw: string, engine: ExtensionEngine): EnginePackageEntry[] {
  const packages: EnginePackageEntry[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('Usage:') || line.startsWith('No packages installed')) continue
    if (/^(Manage|Install|Remove|List|Update|Commands|Options)/i.test(line)) continue
    // Typical shapes: "- npm:@foo/bar", "• name 1.2.3", "./local/path"
    const stripped = line.replace(/^[-•*\d)\s]+/, '').trim()
    if (!stripped) continue
    const versionMatch = stripped.match(/\s(\d+\.\d+\.\d+[^\s]*)$/)
    const namePart = versionMatch ? stripped.slice(0, stripped.length - versionMatch[0].length) : stripped
    const name = namePart.split(/\s{2,}/)[0]?.trim()
    if (!name) continue
    const pathPart = namePart.includes(' -> ') ? namePart.split('->')[1]?.trim() : undefined
    packages.push({
      id: name,
      name: name.replace(/^[^:]+:/, '') === '' ? name : name,
      version: versionMatch?.[1],
      scope: 'user',
      manager: name.includes('git:') ? 'git' : name.includes('npm:') ? 'npm' : name.startsWith('.') || name.includes('\\') || name.includes('/') ? 'path' : 'unknown',
      path: pathPart,
    })
  }
  // Pi 的 plain list 需要排除表头行
  return packages.filter((p) => p.name.length > 0 && p.name.length < 200 && (engine === 'pi' ? !/^(Packages|Installed)/i.test(p.name) : true))
}

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

export type SkillOrigin = 'user' | 'project' | 'package' | 'engine-dir' | 'instruction'

export interface EngineSkillEntry {
  engine: ExtensionEngine
  name: string
  description?: string
  filePath: string
  origin: SkillOrigin
  originLabel: string
  /** 是否注册为引擎可调用技能（斜杠命令）。 */
  executable: boolean
}

export interface EngineSkillSnapshot {
  engine: ExtensionEngine
  engineReady: boolean
  engineVersion: string | null
  projectPath: string | null
  skills: EngineSkillEntry[]
  note?: string
  errors: string[]
  fetchedAt: number
}

/** Parse `omp skill list --json` (`{skills: [{name, description, filePath, baseDir, source, hide}]}`). */
export function parseOmpSkillListJson(raw: string): { skills: EngineSkillEntry[]; errors: string[] } {
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { skills: [], errors: [raw.slice(0, 300)] }
  }
  if (!parsed || typeof parsed !== 'object') return { skills: [], errors }
  const obj = parsed as Record<string, unknown>
  const skills: EngineSkillEntry[] = []
  for (const item of Array.isArray(obj.skills) ? obj.skills : []) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name : null
    const filePath = typeof rec.filePath === 'string' ? rec.filePath : typeof rec.baseDir === 'string' ? rec.baseDir : null
    if (!name || !filePath) continue
    const source = typeof rec.source === 'string' ? rec.source : 'omp:user'
    skills.push({
      engine: 'omp',
      name,
      description: typeof rec.description === 'string' ? rec.description : undefined,
      filePath,
      origin: source.startsWith('claude:') || source.startsWith('codex:') || source.includes(':')
        ? 'engine-dir'
        : source.includes('plugin') ? 'package' : 'user',
      originLabel: source,
      executable: rec.hide !== true,
    })
  }
  for (const w of Array.isArray(obj.warnings) ? obj.warnings : []) {
    if (typeof w === 'string') errors.push(w)
  }
  return { skills, errors }
}

/** Minimal SKILL.md frontmatter parser (name/description between --- fences). */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const body = match[1]
  const readKey = (key: string): string | undefined => {
    const line = body.split(/\r?\n/).find((l) => new RegExp(`^${key}\\s*:`).test(l))
    if (!line) return undefined
    const value = line.slice(line.indexOf(':') + 1).trim()
    return value.replace(/^["']|["']$/g, '') || undefined
  }
  return { name: readKey('name'), description: readKey('description') }
}

// ---------------------------------------------------------------------------
// 使用情况
// ---------------------------------------------------------------------------

export interface UsageFilters {
  /** YYYY-MM-DD（含）。 */
  from?: string | null
  to?: string | null
  projectId?: string | null
  engine?: HarnessId | 'all'
  model?: string | null
}

export interface UsageUsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costTotal: number | null
  calls: number
  /** 其中携带引擎费用数据的调用数；costCalls < calls 表示费用只覆盖一部分（估算值）。 */
  costCalls: number
}

export interface UsageModelRow extends UsageUsageTotals {
  engine: HarnessId
  model: string
}

export interface UsageDayRow extends UsageUsageTotals {
  date: string
}

export interface UsageProjectRow extends UsageUsageTotals {
  projectId: string | null
  projectName: string
  engines: Partial<Record<HarnessId, number>>
}

export interface UsageSessionRow extends UsageUsageTotals {
  threadId: string
  title: string
  engine: HarnessId
  projectId: string | null
  date: string | null
  /** 引擎回报的会话上下文总量（get_session_stats / tokenUsage）。 */
  liveContextTokens: number | null
  validated: boolean
}

export interface EngineGlobalUsage {
  engine: HarnessId
  label: string
  source: string
  available: boolean
  requests?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  cost?: number | null
  note?: string
}

export interface AccountQuota {
  available: boolean
  source: string
  providers: Array<{ provider: string; label?: string; usedPercent?: number | null; note?: string }>
  note?: string
}

export interface UsageReport {
  fetchedAt: number
  totals: UsageUsageTotals
  byDay: UsageDayRow[]
  byModel: UsageModelRow[]
  byProject: UsageProjectRow[]
  sessions: UsageSessionRow[]
  /** 活动会话的上下文占用（与 Token 消耗分开显示）。 */
  contextUsage: Array<ContextUsageInfo & { threadId: string; title: string; engine: HarnessId }>
  engineGlobals: EngineGlobalUsage[]
  accountQuota: AccountQuota | null
  warnings: string[]
}

export interface UsageRecord {
  /** 全局去重键：单次模型调用一条记录。 */
  key: string
  engine: HarnessId
  projectId: string | null
  threadId: string
  sessionPath: string
  date: string | null
  timestamp: number | null
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costTotal: number | null
}

export function dateKeyOf(timestamp: number | null, localOffsetMs?: number): string | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null
  const d = new Date(timestamp + (localOffsetMs ?? 0))
  const month = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * Aggregate deduped usage records with filters. Pure & testable.
 * Dedupe happens before aggregation (`key` per single model call), so resumed,
 * forked and replayed sessions never double-count.
 * 费用字段：只有任一记录携带引擎提供的费用时才输出数值，否则统一为 null（未提供）。
 */
export function aggregateUsage(records: readonly UsageRecord[], filters: UsageFilters = {}): {
  totals: UsageUsageTotals
  byDay: UsageDayRow[]
  byModel: UsageModelRow[]
  byProject: UsageProjectRow[]
  sessions: UsageSessionRow[]
} {
  const match = (rec: UsageRecord): boolean => {
    if (filters.from && (!rec.date || rec.date < filters.from)) return false
    if (filters.to && (!rec.date || rec.date > filters.to)) return false
    if (filters.projectId && rec.projectId !== filters.projectId) return false
    if (filters.engine && filters.engine !== 'all' && rec.engine !== filters.engine) return false
    if (filters.model && rec.model !== filters.model) return false
    return true
  }
  // 双保险：即使调用方没有预去重，这里也按记录键（单次模型调用）保留第一条。
  const seenKeys = new Set<string>()
  interface Acc {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
    costTotal: number
    calls: number
    costCalls: number
  }
  const blank = (): Acc => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0, calls: 0, costCalls: 0 })
  const addUsage = (acc: Acc, rec: UsageRecord) => {
    acc.input += rec.input
    acc.output += rec.output
    acc.cacheRead += rec.cacheRead
    acc.cacheWrite += rec.cacheWrite
    acc.totalTokens += rec.totalTokens
    acc.calls += 1
    if (rec.costTotal !== null) {
      acc.costTotal += rec.costTotal
      acc.costCalls += 1
    }
  }
  const totals = blank()
  const byDayMap = new Map<string, Acc & { date: string }>()
  const byModelMap = new Map<string, Acc & { engine: HarnessId; model: string }>()
  const byProjectMap = new Map<string, Acc & { projectId: string | null; projectName: string; engines: Partial<Record<HarnessId, number>> }>()
  const sessionMap = new Map<string, Acc & { threadId: string; engine: HarnessId; projectId: string | null; date: string | null }>()

  for (const rec of records) {
    if (!match(rec)) continue
    if (seenKeys.has(rec.key)) continue
    seenKeys.add(rec.key)
    addUsage(totals, rec)

    const dayKey = rec.date ?? '未知日期'
    const day = byDayMap.get(dayKey) ?? { date: dayKey, ...blank() }
    addUsage(day, rec)
    byDayMap.set(dayKey, day)

    const modelKey = `${rec.engine}|${rec.model ?? '未知模型'}`
    const modelRow = byModelMap.get(modelKey) ?? { engine: rec.engine, model: rec.model ?? '未知模型', ...blank() }
    addUsage(modelRow, rec)
    byModelMap.set(modelKey, modelRow)

    const projKey = rec.projectId ?? 'none'
    const projRow = byProjectMap.get(projKey) ?? { projectId: rec.projectId, projectName: '', engines: {}, ...blank() }
    projRow.engines[rec.engine] = (projRow.engines[rec.engine] ?? 0) + rec.totalTokens
    addUsage(projRow, rec)
    byProjectMap.set(projKey, projRow)

    const session = sessionMap.get(rec.threadId) ?? {
      threadId: rec.threadId, engine: rec.engine, projectId: rec.projectId, date: rec.date, ...blank(),
    }
    addUsage(session, rec)
    sessionMap.set(rec.threadId, session)
  }

  const toTotals = (acc: Acc): UsageUsageTotals => ({
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    totalTokens: acc.totalTokens,
    costTotal: acc.costCalls > 0 ? acc.costTotal : null,
    calls: acc.calls,
    costCalls: acc.costCalls,
  })

  return {
    totals: toTotals(totals),
    byDay: [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, ...toTotals(d) })),
    byModel: [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens).map((d) => ({ ...d, ...toTotals(d) })),
    byProject: [...byProjectMap.values()].sort((a, b) => b.totalTokens - a.totalTokens).map((d) => ({ ...d, ...toTotals(d) })),
    sessions: [...sessionMap.values()].sort((a, b) => b.totalTokens - a.totalTokens).map((d) => ({
      threadId: d.threadId,
      title: '',
      engine: d.engine,
      projectId: d.projectId,
      date: d.date,
      ...toTotals(d),
      liveContextTokens: null,
      validated: false,
    })),
  }
}

/** Extract per-model-call usage records from one raw session file (Pi/OMP/Prime JSONL or Claude JSONL). */
export function extractUsageRecordsFromSession(
  sessionPath: string,
  content: string,
  meta: { engine: HarnessId; threadId: string; projectId: string | null },
): UsageRecord[] {
  const records: UsageRecord[] = []
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj || typeof obj !== 'object') continue
    const rec = obj as Record<string, unknown>
    const message = (rec.message && typeof rec.message === 'object' && !Array.isArray(rec.message))
      ? (rec.message as Record<string, unknown>)
      : null

    // Pi / OMP / Prime style: {type:'message', id, message:{role:'assistant', usage:{...}, model, timestamp}}
    // Claude style: {uuid, type:'assistant', message:{role:'assistant', usage:{input_tokens,...}, model}, timestamp}
    const role = message && typeof message.role === 'string' ? message.role : null
    if (role !== 'assistant' || !message) continue
    const usageRaw = message.usage
    if (!usageRaw || typeof usageRaw !== 'object' || Array.isArray(usageRaw)) continue
    const usage = usageRaw as Record<string, unknown>
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const input = num(usage.input) || num(usage.input_tokens)
    const output = num(usage.output) || num(usage.output_tokens)
    const cacheRead = num(usage.cacheRead) || num(usage.cache_read_input_tokens)
    const cacheWrite = num(usage.cacheWrite) || num(usage.cache_creation_input_tokens)
    const totalTokens = typeof usage.totalTokens === 'number' && usage.totalTokens > 0
      ? usage.totalTokens
      : input + output + cacheRead + cacheWrite
    const costObj = usage.cost
    const costTotal = costObj && typeof costObj === 'object' && !Array.isArray(costObj) && typeof (costObj as Record<string, unknown>).total === 'number'
      ? (costObj as Record<string, unknown>).total as number
      : null
    const entryId = typeof rec.id === 'string' && rec.id
      ? rec.id
      : typeof rec.uuid === 'string' && rec.uuid
        ? rec.uuid
        : null
    const parseTs = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
      return null
    }
    const timestamp = parseTs(rec.timestamp) ?? parseTs(message.timestamp)
    if (totalTokens === 0 && costTotal === null) continue
    records.push({
      key: entryId ? `${meta.engine}:${entryId}` : `${meta.engine}:${sessionPath}:${records.length}`,
      engine: meta.engine,
      projectId: meta.projectId,
      threadId: meta.threadId,
      sessionPath,
      date: dateKeyOf(timestamp),
      timestamp,
      model: typeof message.model === 'string' ? message.model : null,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      costTotal,
    })
  }
  return records
}

/** Parse `omp stats --json` overall block (defensive; shape may grow). */
export function parseOmpStatsJson(raw: string): EngineGlobalUsage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const overall = (parsed as Record<string, unknown>).overall
  if (!overall || typeof overall !== 'object') return null
  const o = overall as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    engine: 'omp',
    label: 'OMP 引擎全局统计',
    source: 'omp stats --json',
    available: true,
    requests: num(o.totalRequests),
    inputTokens: num(o.totalInputTokens),
    outputTokens: num(o.totalOutputTokens),
    cacheReadTokens: num(o.totalCacheReadTokens),
    cacheWriteTokens: num(o.totalCacheWriteTokens),
    cost: num(o.totalCost),
  }
}

/** Parse `omp usage --json` (provider quota reports; empty when none). */
export function parseOmpUsageJson(raw: string): AccountQuota {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { available: false, source: 'omp usage --json', providers: [], note: '无法解析 omp usage 输出' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { available: false, source: 'omp usage --json', providers: [], note: '输出为空' }
  }
  const obj = parsed as Record<string, unknown>
  const providers: AccountQuota['providers'] = []
  for (const item of Array.isArray(obj.reports) ? obj.reports : []) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const provider = typeof rec.provider === 'string' ? rec.provider : typeof rec.providerId === 'string' ? rec.providerId : null
    if (!provider) continue
    const percentCandidates = [rec.usedPercent, rec.percent, rec.limitPercent, rec.usagePercent]
    const usedPercent = percentCandidates.find((v) => typeof v === 'number' && Number.isFinite(v)) as number | undefined
    providers.push({
      provider,
      label: typeof rec.label === 'string' ? rec.label : undefined,
      usedPercent: usedPercent ?? null,
      note: typeof rec.plan === 'string' ? rec.plan : undefined,
    })
  }
  return {
    available: providers.length > 0,
    source: 'omp usage --json',
    providers,
    note: providers.length === 0 ? '当前没有已认证账户的用量报告' : undefined,
  }
}

/** Parse `prime-agent sessions --json` (defensive; requires the Prime daemon). */
export function parsePrimeSessionsJson(raw: string): { usage: EngineGlobalUsage | null; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { usage: null, errors: [raw.slice(0, 240)] }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as Record<string, unknown>)?.sessions)
    ? ((parsed as Record<string, unknown>).sessions as unknown[])
    : []
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let anyCost = false
  let counted = 0
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const usage = (rec.usage && typeof rec.usage === 'object' && !Array.isArray(rec.usage))
      ? (rec.usage as Record<string, unknown>)
      : rec
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    input += num(usage.inputTokens) || num(usage.input) || num(usage.input_tokens)
    output += num(usage.outputTokens) || num(usage.output) || num(usage.output_tokens)
    cacheRead += num(usage.cacheReadTokens) || num(usage.cacheRead) || num(usage.cache_read_input_tokens)
    cacheWrite += num(usage.cacheWriteTokens) || num(usage.cacheWrite) || num(usage.cache_creation_input_tokens)
    const c = num(usage.cost) || num(usage.costTotal) || num(usage.totalCost)
    if (c > 0 || (usage.cost !== undefined && usage.cost !== null)) anyCost = true
    cost += c
    counted += 1
  }
  if (counted === 0) {
    return { usage: null, errors: [] }
  }
  return {
    usage: {
      engine: 'prime',
      label: 'Prime Agent 全局统计',
      source: 'prime-agent sessions --json',
      available: true,
      requests: counted,
      inputTokens: input || null,
      outputTokens: output || null,
      cacheReadTokens: cacheRead || null,
      cacheWriteTokens: cacheWrite || null,
      cost: anyCost ? cost : null,
      note: '缺失的字段以「未提供」显示',
    },
    errors: [],
  }
}

export { resolveMcpShadowing }
