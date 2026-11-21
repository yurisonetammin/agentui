import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  collectMcpEntries,
  resolveMcpShadowing,
  type McpFileSpec,
  type RawMcpEntry,
} from '@shared/mcp-config'
import {
  EXTENSION_ENGINE_CAPABILITIES,
  parsePiMcpListJson,
  type McpAddInput,
  type McpConfigFileInfo,
  type McpEngineSnapshot,
  type McpServerEntry,
  type McpSessionState,
  type ExtensionEngine,
} from '@shared/extensions'
import type { HarnessDiscoveryService } from '../discovery'
import { runEngineCli } from './engine-cli'

export interface EngineSessionRuntimeState {
  hasLiveSession: boolean
  startedAt: number | null
}

export interface EngineMcpServiceDeps {
  discovery: HarnessDiscoveryService
  /** 返回该引擎在指定项目下的运行中会话状态。 */
  getSessionState: (engine: ExtensionEngine, projectPath: string | null) => EngineSessionRuntimeState
}

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function writeJsonFileAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function isValidMcpName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && name.length <= 128
}

interface SpecLoad {
  spec: McpFileSpec
  /** null = 文件不存在；命中时按 spec 解析。 */
  content: string | null
}

export class EngineMcpService {
  constructor(private readonly deps: EngineMcpServiceDeps) {}

  private agentDir(engine: ExtensionEngine): string {
    return this.deps.discovery.snapshot()[engine].agentDir
  }

  private homeDir(): string {
    return process.env.USERPROFILE || process.env.HOME || ''
  }

  /** Load + rank engine-specific config sources into a snapshot. */
  async getSnapshot(engine: ExtensionEngine, projectPath?: string | null, liveCheck = false): Promise<McpEngineSnapshot> {
    const status = this.deps.discovery.snapshot()[engine]
    const errors: string[] = []
    const project = projectPath && existsSync(projectPath) ? projectPath : null
    const loads: SpecLoad[] = []
    const fileInfos: McpConfigFileInfo[] = []

    const addSpec = (spec: McpFileSpec, info: Pick<McpConfigFileInfo, 'writable'> & { note?: string }, injected?: string) => {
      const content = injected !== undefined ? injected : readFileOrNull(spec.path)
      loads.push({ spec, content })
      fileInfos.push({
        path: spec.path,
        label: spec.label,
        scope: spec.scope,
        kind: spec.kind,
        exists: injected !== undefined || content !== null,
        ...info,
      })
    }

    if (engine === 'pi') {
      if (project) addSpec(
        { path: join(project, '.pi', 'mcp.json'), kind: 'json', scope: 'project', label: 'Pi 项目级 .pi/mcp.json', rank: 1, managed: true },
        { writable: true, note: '仅在 Pi 信任该项目后由 Pi 读取' },
      )
      addSpec(
        { path: join(this.agentDir('pi'), 'mcp.json'), kind: 'json', scope: 'user', label: 'Pi 用户级 mcp.json', rank: 2, managed: true },
        { writable: true },
      )
    } else if (engine === 'omp') {
      const agentDir = this.agentDir('omp')
      if (project) {
        addSpec(
          { path: join(project, '.omp', 'mcp.json'), kind: 'json', scope: 'project', label: 'OMP 项目级 .omp/mcp.json', rank: 1, managed: true },
          { writable: true },
        )
        addSpec(
          { path: join(project, '.omp', '.mcp.json'), kind: 'json', scope: 'project', label: 'OMP 项目级 .omp/.mcp.json（兼容）', rank: 2, managed: true },
          { writable: true },
        )
      }
      addSpec(
        { path: join(agentDir, 'mcp.json'), kind: 'json', scope: 'user', label: 'OMP 用户级 mcp.json', rank: 3, managed: true },
        { writable: true },
      )
      addSpec(
        { path: join(agentDir, '.mcp.json'), kind: 'json', scope: 'user', label: 'OMP 用户级 .mcp.json（兼容）', rank: 4, managed: true },
        { writable: true },
      )
      // 第三方发现来源（rank 按 OMP mcp-config 文档的优先级；只读展示）
      const home = this.homeDir()
      const claudeFilter = project ? [project] : undefined
      addSpec(
        { path: join(home, '.claude.json'), kind: 'json', scope: 'third-party', label: 'Claude Code (~/.claude.json)', rank: 5, managed: false, claudePerProjectFilter: claudeFilter },
        { writable: false, note: '由 Claude Code 管理；含按项目嵌套的条目' },
      )
      addSpec(
        { path: join(home, '.claude', 'mcp.json'), kind: 'json', scope: 'third-party', label: 'Claude Code (~/.claude/mcp.json)', rank: 5, managed: false },
        { writable: false },
      )
      if (project) addSpec(
        { path: join(project, '.claude', 'mcp.json'), kind: 'json', scope: 'third-party', label: 'Claude Code (项目 .claude/mcp.json)', rank: 5, managed: false },
        { writable: false },
      )
      addSpec(
        { path: join(home, '.codex', 'config.toml'), kind: 'toml', scope: 'third-party', label: 'Codex (~/.codex/config.toml)', rank: 6, managed: false },
        { writable: false },
      )
      if (project) addSpec(
        { path: join(project, '.codex', 'config.toml'), kind: 'toml', scope: 'third-party', label: 'Codex (项目 .codex/config.toml)', rank: 6, managed: false },
        { writable: false },
      )
      addSpec(
        { path: join(home, '.gemini', 'settings.json'), kind: 'json', scope: 'third-party', label: 'Gemini CLI (~/.gemini/settings.json)', rank: 7, managed: false },
        { writable: false },
      )
      addSpec(
        { path: join(home, '.cursor', 'mcp.json'), kind: 'json', scope: 'third-party', label: 'Cursor (~/.cursor/mcp.json)', rank: 8, managed: false },
        { writable: false },
      )
      addSpec(
        { path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), kind: 'json', scope: 'third-party', label: 'Windsurf (mcp_config.json)', rank: 9, managed: false },
        { writable: false },
      )
      if (project) {
        // VS Code 的格式是 {mcp: {servers: {...}}}，抽取内层后按统一结构解析。
        const vscodePath = join(project, '.vscode', 'mcp.json')
        const vscodeRaw = readFileOrNull(vscodePath)
        let vscodeInner: string | null = null
        if (vscodeRaw !== null) {
          try {
            const parsed = JSON.parse(vscodeRaw) as Record<string, unknown>
            const mcp = parsed.mcp
            if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
              const servers = (mcp as Record<string, unknown>).servers
              if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
                vscodeInner = JSON.stringify(servers)
              }
            }
          } catch { /* 坏 JSON 忽略 */ }
        }
        if (vscodeInner !== null) {
          addSpec(
            { path: vscodePath, kind: 'json', scope: 'third-party', label: 'VS Code (项目 .vscode/mcp.json)', rank: 10, managed: false },
            { writable: false },
            vscodeInner,
          )
        }
      }
      if (project) {
        addSpec(
          { path: join(project, 'mcp.json'), kind: 'json', scope: 'project', label: '项目根 mcp.json（便携回退）', rank: 11, managed: false },
          { writable: false, note: '多个 MCP 客户端共用的回退文件，请手动编辑' },
        )
        addSpec(
          { path: join(project, '.mcp.json'), kind: 'json', scope: 'project', label: '项目根 .mcp.json（便携回退）', rank: 11, managed: false },
          { writable: false, note: '多个 MCP 客户端共用的回退文件，请手动编辑' },
        )
      }
    } else {
      // Prime：用户级服务器存于 data 目录 settings.json 的 mcpServers，由 CLI 管理（可增删）。
      addSpec(
        { path: join(this.agentDir('prime'), 'settings.json'), kind: 'json', scope: 'user', label: 'Prime 用户级 settings.json (mcpServers)', rank: 1, managed: false, deletable: true, serverKeys: ['mcpServers'] },
        { writable: false, note: '经 prime-agent mcp add/remove 管理；认证交给 Prime' },
      )
    }

    let servers: McpServerEntry[] = []
    try {
      const raw: RawMcpEntry[] = collectMcpEntries(loads)
      servers = resolveMcpShadowing(raw) as McpServerEntry[]
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }

    // Pi：可选的实况检查（会实际连接服务器，耗时较长；传入项目目录使项目级配置纳入检查）。
    if (engine === 'pi' && liveCheck) {
      try {
        const res = await runEngineCli('pi', this.deps.discovery, ['mcp', 'list', '--json'], { cwd: project ?? undefined, timeoutMs: 45_000 })
        const { live, errors: liveErrors } = parsePiMcpListJson(res.combined || res.stdout)
        for (const entry of servers) {
          const l = live[entry.name]
          if (l) entry.live = l
        }
        errors.push(...liveErrors)
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }

    return {
      engine,
      engineReady: status.ready,
      engineVersion: status.version,
      projectPath: project,
      configFiles: fileInfos,
      servers,
      sessionState: this.sessionState(engine, project),
      errors,
      fetchedAt: Date.now(),
    }
  }

  private sessionState(engine: ExtensionEngine, project: string | null): McpSessionState {
    const runtime = this.deps.getSessionState(engine, project)
    if (!runtime.hasLiveSession) {
      return { hasLiveSession: false, configChangedAfterStart: null, detail: '当前没有该引擎的运行中会话；配置将在下次启动会话时生效。' }
    }
    let changed: boolean | null = null
    for (const path of this.managedConfigPaths(engine, project)) {
      try {
        if (!existsSync(path)) continue
        if (runtime.startedAt !== null && statSync(path).mtimeMs > runtime.startedAt) changed = true
      } catch { /* ignore */ }
    }
    return {
      hasLiveSession: true,
      configChangedAfterStart: changed,
      detail: changed
        ? '配置文件在会话启动后被修改过：运行中的会话继续使用启动时加载的配置，空闲后重连即可生效。'
        : '运行中的会话已加载当前配置。',
    }
  }

  private managedConfigPaths(engine: ExtensionEngine, project: string | null): string[] {
    if (engine === 'pi') {
      return [
        join(this.agentDir('pi'), 'mcp.json'),
        ...(project ? [join(project, '.pi', 'mcp.json')] : []),
      ]
    }
    if (engine === 'omp') {
      const agentDir = this.agentDir('omp')
      return [
        join(agentDir, 'mcp.json'),
        join(agentDir, '.mcp.json'),
        ...(project ? [join(project, '.omp', 'mcp.json'), join(project, '.omp', '.mcp.json')] : []),
      ]
    }
    return [join(this.agentDir('prime'), 'settings.json')]
  }

  async addServer(input: McpAddInput, projectPath?: string | null): Promise<McpEngineSnapshot> {
    if (!isValidMcpName(input.name)) throw new Error('服务器名称只能包含字母、数字、点、横线和下划线')
    if (input.transport === 'stdio' && !input.command?.trim()) throw new Error('stdio 服务器需要提供启动命令')
    if (input.transport === 'http' && !input.url?.trim()) throw new Error('远程服务器需要提供 URL')
    if (input.url) {
      try {
        const parsed = new URL(input.url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
      } catch {
        throw new Error('URL 必须是合法的 http(s) 地址')
      }
    }
    const caps = EXTENSION_ENGINE_CAPABILITIES[input.engine]
    if (input.scope === 'project' && !caps.mcp.manageProject) {
      throw new Error('该引擎不支持项目级 MCP 配置')
    }
    if (input.scope === 'project' && !(projectPath && existsSync(projectPath))) {
      throw new Error('项目级配置需要先选择一个有效项目')
    }

    if (input.engine === 'pi') {
      const args = ['mcp', 'add', input.name]
      if (input.scope === 'project') args.push('-l')
      if (input.description?.trim()) args.push('--description', input.description.trim())
      if (input.transport === 'http') {
        args.push('--url', input.url!.trim())
        for (const header of input.headers ?? []) {
          if (header.key.trim()) args.push('--header', `${header.key.trim()}=${header.value}`)
        }
        if (input.bearerTokenEnvVar?.trim()) args.push('--bearer-token-env-var', input.bearerTokenEnvVar.trim())
      } else {
        for (const env of input.env ?? []) {
          if (env.key.trim()) args.push('--env', `${env.key.trim()}=${env.value}`)
        }
        if (input.cwd?.trim()) args.push('--cwd', input.cwd.trim())
        args.push('--', input.command!.trim(), ...(input.args ?? []).filter((a) => a.trim()))
      }
      const res = await runEngineCli('pi', this.deps.discovery, args, { cwd: input.scope === 'project' ? projectPath : undefined, timeoutMs: 30_000 })
      if (!res.ok) throw new Error(`pi mcp add 失败: ${res.combined.slice(0, 400)}`)
      return this.getSnapshot('pi', projectPath)
    }

    if (input.engine === 'prime') {
      const args = ['mcp', 'add', input.name]
      if (input.transport === 'http') {
        args.push('--url', input.url!.trim())
        if (input.bearerTokenEnvVar?.trim()) args.push('--bearer-token-env-var', input.bearerTokenEnvVar.trim())
      } else {
        if (input.cwd?.trim()) args.push('--cwd', input.cwd.trim())
        for (const env of input.env ?? []) {
          if (env.key.trim()) args.push('--env', `${env.key.trim()}=${env.value}`)
        }
        args.push('--', input.command!.trim(), ...(input.args ?? []).filter((a) => a.trim()))
      }
      const res = await runEngineCli('prime', this.deps.discovery, args, { timeoutMs: 30_000 })
      if (!res.ok) throw new Error(`prime-agent mcp add 失败: ${res.combined.slice(0, 400)}`)
      return this.getSnapshot('prime', projectPath)
    }

    // OMP：直接写入 OMP 自有配置文件（用户级 mcp.json 或项目 .omp/mcp.json）。
    const targetPath = input.scope === 'project' && projectPath
      ? join(projectPath, '.omp', 'mcp.json')
      : join(this.agentDir('omp'), 'mcp.json')
    let doc: Record<string, unknown> = {}
    const existing = readFileOrNull(targetPath)
    if (existing !== null) {
      try {
        const parsed = JSON.parse(existing) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>
      } catch {
        throw new Error(`目标配置文件不是合法 JSON，请先手动修复: ${targetPath}`)
      }
    }
    const map = (doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)
      ? doc.mcpServers
      : {}) as Record<string, unknown>
    if (existing !== null && Object.prototype.hasOwnProperty.call(map, input.name)) {
      throw new Error(`同名服务器已存在于 ${targetPath}，请先删除或改名`)
    }
    const entry: Record<string, unknown> = input.transport === 'http'
      ? { url: input.url!.trim() }
      : {
          command: input.command!.trim(),
          ...(input.args?.length ? { args: input.args.filter((a) => a.trim()) } : {}),
          ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
        }
    if (input.env?.length) {
      const env: Record<string, string> = {}
      for (const pair of input.env) if (pair.key.trim()) env[pair.key.trim()] = pair.value
      entry.env = env
    }
    if (input.headers?.length) {
      const headers: Record<string, string> = {}
      for (const pair of input.headers) if (pair.key.trim()) headers[pair.key.trim()] = pair.value
      entry.headers = headers
    }
    if (input.description?.trim()) entry.description = input.description.trim()
    map[input.name] = entry
    doc.mcpServers = map
    writeJsonFileAtomic(targetPath, doc)
    return this.getSnapshot('omp', projectPath)
  }

  async removeServer(engine: ExtensionEngine, scope: 'user' | 'project', name: string, projectPath?: string | null): Promise<McpEngineSnapshot> {
    if (!isValidMcpName(name)) throw new Error('无效的服务器名称')
    if (engine === 'pi') {
      const args = scope === 'project' ? ['mcp', 'remove', name, '-l'] : ['mcp', 'remove', name]
      const res = await runEngineCli('pi', this.deps.discovery, args, { cwd: scope === 'project' ? projectPath : undefined, timeoutMs: 20_000 })
      if (!res.ok) throw new Error(`pi mcp remove 失败: ${res.combined.slice(0, 400)}`)
      return this.getSnapshot('pi', projectPath)
    }
    if (engine === 'prime') {
      const res = await runEngineCli('prime', this.deps.discovery, ['mcp', 'remove', name], { timeoutMs: 20_000 })
      if (!res.ok) throw new Error(`prime-agent mcp remove 失败: ${res.combined.slice(0, 400)}`)
      return this.getSnapshot('prime', projectPath)
    }
    // OMP：从自有配置文件中移除。
    const candidates = scope === 'project' && projectPath
      ? [join(projectPath, '.omp', 'mcp.json'), join(projectPath, '.omp', '.mcp.json')]
      : [join(this.agentDir('omp'), 'mcp.json'), join(this.agentDir('omp'), '.mcp.json')]
    let removedFrom: string | null = null
    for (const path of candidates) {
      const content = readFileOrNull(path)
      if (content === null) continue
      let doc: Record<string, unknown>
      try {
        const parsed = JSON.parse(content) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        doc = parsed as Record<string, unknown>
      } catch {
        continue
      }
      const map = doc.mcpServers
      if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.prototype.hasOwnProperty.call(map, name)) continue
      delete (map as Record<string, unknown>)[name]
      writeJsonFileAtomic(path, doc)
      removedFrom = path
      break
    }
    if (!removedFrom) throw new Error(`未在 OMP 自有配置中找到服务器 ${name}（第三方来源请在对应工具中删除）`)
    return this.getSnapshot('omp', projectPath)
  }
}
