/**
 * MCP 配置文件解析（纯函数，主进程各服务与 browser-companion 共用）。
 *
 * `parseMcpConfigFiles` 保持与 browser-companion 原实现完全一致的语义
 * （Claude ~/.claude.json 顶层 + per-project、项目 .mcp.json、Gemini JSON、
 * Codex config.toml 的 [mcp_servers.*] 段），browser-companion 从这里 re-export。
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface RawMcpEntry {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  envKeys?: string[]
  url?: string
  headerKeys?: string[]
  description?: string
  enabled?: boolean
  /** 优先级，1 = 最高（同名时获胜）。 */
  rank: number
  /** 配置文件路径或来源标签。 */
  source: string
  /** 展示用来源名（用户级 mcp.json / 项目 .omp/mcp.json / Claude Code ...）。 */
  sourceLabel: string
  scope: 'user' | 'project' | 'third-party'
  /** AgentUI 是否可直接编辑该条目（OMP 自有配置 = true，第三方只读）。 */
  managed: boolean
  /** AgentUI 能否删除该条目（经 CLI 或配置文件；Prime settings.json 由 CLI 管理但可删）。 */
  deletable?: boolean
  /** 同名/同端点条目被更高优先级来源覆盖时，记录获胜方展示名。 */
  shadowedBy?: string
}

export interface McpConfigFile {
  source: string
  kind: 'json' | 'toml'
  content: string
}

export function isBrowserLikeMcp(entry: { name: string; command?: string; args?: string[]; url?: string }): boolean {
  const haystack = [entry.name, entry.command ?? '', ...(entry.args ?? []), entry.url ?? ''].join(' ')
  return /browser|playwright|puppeteer|chrome|chromium|\bego\b|ego-|browsermcp|browser-use/i.test(haystack)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeServerEntry(
  source: string,
  name: string,
  raw: unknown,
): { name: string; source: string; command?: string; args?: string[]; url?: string; browserLike: boolean } | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const command = typeof obj.command === 'string' ? obj.command : undefined
  const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === 'string') : undefined
  const url = typeof obj.url === 'string' ? obj.url : undefined
  if (!command && !url) return null
  const entry = { name, command, args, url }
  return { source, ...entry, browserLike: isBrowserLikeMcp(entry) }
}

/** Minimal TOML reader for Codex `[mcp_servers.<name>]` sections (command/args/url only). */
function tomlStrings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) =>
    m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n') : (m[2] ?? ''),
  )
}

export function parseCodexMcpToml(source: string, content: string): { name: string; command?: string; args?: string[]; url?: string }[] {
  const servers: { name: string; command?: string; args?: string[]; url?: string }[] = []
  let current: { name: string; command?: string; args?: string[]; url?: string } | null = null
  let inSubTable = false
  const flush = () => {
    if (current && (current.command || current.url)) {
      servers.push(current)
    }
    current = null
    inSubTable = false
  }
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      const header = line.match(/^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.\]\s]+))(\.[^\]]*)?\]\s*(?:#.*)?$/)
      if (header) {
        const name = header[1] ?? header[2] ?? header[3]
        if (header[4]) {
          // Sub-table such as [mcp_servers.foo.env]: keep the server, ignore its keys.
          if ((current as { name: string } | null)?.name === name) inSubTable = true
          else {
            flush()
            current = { name }
            inSubTable = true
          }
        } else {
          flush()
          current = { name }
        }
      } else {
        flush()
      }
      continue
    }
    if (!current || inSubTable) continue
    const kv = line.match(/^(command|args|url)\s*=\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let value = kv[2].trim()
    if (key === 'args') {
      // Arrays may span several lines; gather until brackets balance.
      while (!/\]\s*(#.*)?$/.test(value) && i + 1 < lines.length) {
        i += 1
        value += ` ${lines[i].trim()}`
      }
      current.args = tomlStrings(value.replace(/^\[|\]\s*(#.*)?$/g, ''))
    } else {
      const [str] = tomlStrings(value)
      if (str !== undefined) {
        if (key === 'command') current.command = str
        else current.url = str
      }
    }
  }
  flush()
  return servers
}

/** Parse MCP config files (Claude / project .mcp.json / Gemini JSON, Codex TOML). Pure & testable. */
export function parseMcpConfigFiles(
  files: readonly McpConfigFile[],
  /** When given, only `~/.claude.json` project entries for these paths are listed. */
  projectPaths?: readonly string[],
): { name: string; command?: string; args?: string[]; url?: string; source: string; browserLike: boolean }[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const allowed = projectPaths ? new Set(projectPaths.map(norm)) : null
  const servers: { name: string; command?: string; args?: string[]; url?: string; source: string; browserLike: boolean }[] = []
  for (const file of files) {
    if (file.kind === 'toml') {
      for (const entry of parseCodexMcpToml(file.source, file.content)) {
        servers.push({ ...entry, source: file.source, browserLike: isBrowserLikeMcp(entry) })
      }
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(file.content)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const root = parsed as Record<string, unknown>
    const collect = (map: unknown, source: string) => {
      if (!map || typeof map !== 'object') return
      for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
        const entry = normalizeServerEntry(source, name, raw)
        if (entry) servers.push(entry)
      }
    }
    collect(root.mcpServers, file.source)
    // ~/.claude.json also nests per-project servers under projects[path].mcpServers
    if (root.projects && typeof root.projects === 'object') {
      for (const [projectPath, proj] of Object.entries(root.projects as Record<string, unknown>)) {
        if (allowed && !allowed.has(norm(projectPath))) continue
        if (proj && typeof proj === 'object') {
          collect((proj as Record<string, unknown>).mcpServers, `${file.source} (${projectPath})`)
        }
      }
    }
  }
  // Dedupe by name + command/url + args, keep first occurrence.
  const seen = new Set<string>()
  return servers.filter((s) => {
    const key = `${s.name}|${s.command ?? ''}|${s.url ?? ''}|${(s.args ?? []).join(' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// 通用富解析：给每个文件打 rank / scope / label，供 MCP 设置页展示覆盖关系。
// ---------------------------------------------------------------------------

export interface McpFileSpec {
  path: string
  kind: 'json' | 'toml'
  scope: 'user' | 'project' | 'third-party'
  label: string
  rank: number
  managed: boolean
  /** 缺省时与 managed 一致；Prime 等由 CLI 管理的来源设 managed:false + deletable:true。 */
  deletable?: boolean
  /** JSON 根对象里承载 servers 映射的键（默认 mcpServers）。 */
  serverKeys?: string[]
  /** 传入时，仅列出 ~/.claude.json 等按项目嵌套的条目。 */
  claudePerProjectFilter?: readonly string[]
}

function inferTransport(raw: Record<string, unknown>): McpTransport {
  if (typeof raw.command === 'string' && raw.command) return 'stdio'
  if (typeof raw.url === 'string' && raw.url) return raw.type === 'sse' ? 'sse' : 'http'
  return 'stdio'
}

function collectJsonMap(map: unknown, spec: McpFileSpec, out: RawMcpEntry[]): void {
  if (!map || typeof map !== 'object') return
  const deletable = spec.deletable ?? spec.managed
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const obj = raw as Record<string, unknown>
    const command = typeof obj.command === 'string' ? obj.command : undefined
    const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === 'string') : undefined
    const url = typeof obj.url === 'string' ? obj.url : undefined
    if (!command && !url) continue
    const transport = inferTransport(obj)
    const env = isRecord(obj.env) ? Object.keys(obj.env) : []
    const headers = isRecord(obj.headers) ? Object.keys(obj.headers) : []
    out.push({
      name,
      transport,
      command,
      args,
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      envKeys: env.length ? env : undefined,
      url,
      headerKeys: headers.length ? headers : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      enabled: obj.enabled === false ? false : true,
      rank: spec.rank,
      source: spec.path,
      sourceLabel: spec.label,
      scope: spec.scope,
      managed: spec.managed,
      deletable,
    })
  }
}

/** Read every spec'd file (already loaded) into ranked raw entries. */
export function collectMcpEntries(files: readonly { spec: McpFileSpec; content: string | null }[]): RawMcpEntry[] {
  const out: RawMcpEntry[] = []
  for (const { spec, content } of files) {
    if (content === null) continue
    if (spec.kind === 'toml') {
      for (const entry of parseCodexMcpToml(spec.path, content)) {
        out.push({
          name: entry.name,
          transport: entry.url ? 'http' : 'stdio',
          command: entry.command,
          args: entry.args,
          url: entry.url,
          enabled: true,
          rank: spec.rank,
          source: spec.path,
          sourceLabel: spec.label,
          scope: spec.scope,
          managed: spec.managed,
          deletable: spec.deletable ?? spec.managed,
        })
      }
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const root = parsed as Record<string, unknown>
    for (const key of spec.serverKeys ?? ['mcpServers']) {
      const direct = root[key]
      if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
        collectJsonMap(direct, spec, out)
      }
    }
    if (spec.claudePerProjectFilter && root.projects && typeof root.projects === 'object') {
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const allowed = new Set(spec.claudePerProjectFilter.map(norm))
      for (const [projectPath, proj] of Object.entries(root.projects as Record<string, unknown>)) {
        if (!allowed.has(norm(projectPath))) continue
        if (proj && typeof proj === 'object') {
          collectJsonMap((proj as Record<string, unknown>).mcpServers, { ...spec, path: `${spec.path} (${projectPath})` }, out)
        }
      }
    }
  }
  return out
}

/**
 * Resolve same-name conflicts the way engines do: first (highest-rank) definition
 * wins; lower-rank same-name entries are kept visible but marked as shadowed.
 * Differently-named duplicates with identical transport/endpoint/args are also
 * shadowed by the higher-ranked one.
 */
export function resolveMcpShadowing(entries: readonly RawMcpEntry[]): RawMcpEntry[] {
  const sorted = [...entries].sort((a, b) => a.rank - b.rank)
  const byName = new Map<string, RawMcpEntry>()
  const fingerprints = new Map<string, RawMcpEntry>()
  const result: RawMcpEntry[] = []
  for (const entry of sorted) {
    const winner = byName.get(entry.name)
    if (winner) {
      result.push({ ...entry, shadowedBy: `${winner.sourceLabel} · ${winner.name}` })
      continue
    }
    const fp = [
      entry.transport,
      entry.command ?? '',
      (entry.args ?? []).join('\u0001'),
      entry.url ?? '',
    ].join('|')
    const sameTarget = fingerprints.get(fp)
    if (sameTarget) {
      result.push({ ...entry, shadowedBy: `${sameTarget.sourceLabel} · ${sameTarget.name}` })
      continue
    }
    byName.set(entry.name, entry)
    fingerprints.set(fp, entry)
    result.push(entry)
  }
  return result
}
