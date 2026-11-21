import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  aggregateUsage,
  extractUsageRecordsFromSession,
  parseOmpPluginListJson,
  parseOmpSkillListJson,
  parseOmpStatsJson,
  parseOmpUsageJson,
  parsePiMcpListJson,
  parsePlainPackageList,
  parsePrimeSessionsJson,
  parseSkillFrontmatter,
  type UsageRecord,
} from '../src/shared/extensions'
import { collectMcpEntries, parseCodexMcpToml, resolveMcpShadowing } from '../src/shared/mcp-config'
import { EngineMcpService, isValidMcpName } from '../electron/main/extensions/mcp-service'
import { EnginePackageService } from '../electron/main/extensions/package-service'
import { EngineSkillService } from '../electron/main/extensions/skill-service'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import type { HarnessId, HarnessStatus } from '../src/shared/types'
import { normalizeUrlInput } from '../src/shared/browser-url'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-ext-test-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('MCP 配置收集与覆盖合并', () => {
  it('按 rank 排序并标记同名被覆盖', () => {
    const entries = collectMcpEntries([
      { spec: { path: 'C:\\proj\\.omp\\mcp.json', kind: 'json', scope: 'project', label: 'OMP 项目级', rank: 1, managed: true }, content: JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['project.js'] } } }) },
      { spec: { path: 'C:\\u\\mcp.json', kind: 'json', scope: 'user', label: 'OMP 用户级', rank: 3, managed: true }, content: JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['user.js'] }, unique: { url: 'https://x.example/mcp' } } }) },
      { spec: { path: 'C:\\Users\\.claude.json', kind: 'json', scope: 'third-party', label: 'Claude Code', rank: 5, managed: false }, content: JSON.stringify({ mcpServers: { unique: { url: 'https://x.example/mcp' } } }) },
    ])
    const resolved = resolveMcpShadowing(entries)
    const shared = resolved.filter((e) => e.name === 'shared')
    expect(shared).toHaveLength(2)
    expect(shared[0]?.shadowedBy).toBeUndefined()
    expect(shared[1]?.shadowedBy).toContain('OMP 项目级')
    const unique = resolved.filter((e) => e.name === 'unique')
    expect(unique).toHaveLength(2)
    // rank 3 的 OMP 用户级获胜（managed = true），rank 5 的 Claude 条目被遮蔽
    expect(unique[0]?.managed).toBe(true)
    expect(unique[1]?.managed).toBe(false)
    expect(unique[1]?.shadowedBy).toContain('OMP 用户级')
  })

  it('collectMcpEntries 支持 codex TOML 与 claude 按项目过滤', () => {
    const entries = collectMcpEntries([
      { spec: { path: '~/.codex/config.toml', kind: 'toml', scope: 'third-party', label: 'Codex', rank: 6, managed: false }, content: '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp"]\n' },
      { spec: { path: '~/.claude.json', kind: 'json', scope: 'third-party', label: 'Claude Code', rank: 5, managed: false, claudePerProjectFilter: ['E:\\repo'] }, content: JSON.stringify({ mcpServers: { top: { command: 'top-cmd' } }, projects: { 'E:\\repo': { mcpServers: { proj: { command: 'proj-cmd' } } }, 'E:\\other': { mcpServers: { hidden: { command: 'x' } } } } }) },
    ])
    const names = entries.map((e) => e.name)
    expect(names).toContain('playwright')
    expect(names).toContain('top')
    expect(names).toContain('proj')
    expect(names).not.toContain('hidden')
    const claudeProj = entries.find((e) => e.name === 'proj')
    expect(claudeProj?.source).toContain('E:\\repo')
  })

  it('parseCodexMcpToml 保持原有解析行为（多行数组/子表）', () => {
    const servers = parseCodexMcpToml('t.toml', '[mcp_servers.a]\ncommand = "npx"\nargs = [\n  "-y",\n  "pkg",\n]\n[mcp_servers.a.env]\nKEY = "x"\n')
    expect(servers).toHaveLength(1)
    expect(servers[0]).toEqual({ name: 'a', command: 'npx', args: ['-y', 'pkg'] })
  })
})

describe('MCP 服务（OMP 自有配置读写）', () => {
  it('addServer 写入用户级 mcp.json 并能在快照中读回', async () => {
    const home = makeTempDir()
    const service = new EngineMcpService({
      discovery: stubDiscovery({ omp: { ready: true, agentDir: home, version: '18.18.9' } }),
      getSessionState: () => ({ hasLiveSession: false, startedAt: null }),
    })
    const snap = await service.addServer({
      engine: 'omp', scope: 'user', name: 'github', transport: 'stdio',
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
      env: [{ key: 'GH_TOKEN', value: 'x' }],
    })
    const written = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(written.mcpServers.github).toMatchObject({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] })
    const entry = snap.servers.find((s) => s.name === 'github')
    expect(entry).toBeDefined()
    expect(entry?.envKeys).toEqual(['GH_TOKEN'])
    expect(entry?.managed).toBe(true)
    expect(entry?.rank).toBe(3)
  })

  it('removeServer 从配置文件删除条目，找不到时报错', async () => {
    const home = makeTempDir()
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { gone: { command: 'x' } } }), 'utf8')
    const service = new EngineMcpService({
      discovery: stubDiscovery({ omp: { ready: true, agentDir: home } }),
      getSessionState: () => ({ hasLiveSession: false, startedAt: null }),
    })
    await service.removeServer('omp', 'user', 'gone')
    const after = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(after.mcpServers)).toHaveLength(0)
    await expect(service.removeServer('omp', 'user', 'missing')).rejects.toThrow('未在 OMP 自有配置中找到')
  })

  it('拒绝非法名称；CLI 未就绪的引擎抛错', async () => {
    const service = new EngineMcpService({
      discovery: stubDiscovery({ pi: { ready: false } }),
      getSessionState: () => ({ hasLiveSession: false, startedAt: null }),
    })
    expect(isValidMcpName('ok.name-1')).toBe(true)
    expect(isValidMcpName('-leading')).toBe(false)
    expect(isValidMcpName('has space')).toBe(false)
    await expect(service.addServer({ engine: 'omp', scope: 'user', name: '-bad', transport: 'http', url: 'https://x' }))
      .rejects.toThrow('服务器名称')
    await expect(service.addServer({ engine: 'pi', scope: 'user', name: 'pi-srv', transport: 'stdio', command: 'npx' }))
      .rejects.toThrow('未就绪')
  })

  it('Prime 条目经 CLI 管理：managed=false 但 deletable=true（界面可删）', async () => {
    const home = makeTempDir()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
        mcpServers: { 'prime-srv': { url: 'https://mcp.example/sse' } },
    }), 'utf8')
    const service = new EngineMcpService({
      discovery: stubDiscovery({ prime: { ready: true, agentDir: home } }),
      getSessionState: () => ({ hasLiveSession: false, startedAt: null }),
    })
    const snap = await service.getSnapshot('prime', null)
    const entry = snap.servers.find((s) => s.name === 'prime-srv')
    expect(entry).toBeDefined()
    expect(entry?.managed).toBe(false)
    expect(entry?.deletable).toBe(true)
    expect(snap.configFiles[0]?.writable).toBe(false)
  })

  it('OMP 第三方来源不可删（deletable=false）', () => {
    const entries = collectMcpEntries([
      { spec: { path: '~/.claude.json', kind: 'json', scope: 'third-party', label: 'Claude Code', rank: 5, managed: false }, content: JSON.stringify({ mcpServers: { remote: { url: 'https://a.example' } } }) },
    ])
    expect(entries[0]?.deletable).toBe(false)
    expect(entries[0]?.managed).toBe(false)
  })
})

describe('插件操作范围', () => {
  it('拒绝 Prime 的项目级操作，保留其他引擎的项目目录校验', async () => {
    const service = new EnginePackageService(stubDiscovery({}))
    const project = makeTempDir()
    await expect(service.install('prime', 'local-package', 'project', project)).rejects.toThrow('仅支持用户级')
    await expect(service.update('prime', 'local-package', 'project', project)).rejects.toThrow('仅支持用户级')
    await expect(service.remove('prime', 'local-package', 'project', project)).rejects.toThrow('仅支持用户级')
    await expect(service.install('pi', 'local-package', 'project', project)).rejects.toThrow('未就绪')
    await expect(service.update('omp', 'local-package', 'project')).rejects.toThrow('有效项目')
  })
})

describe('技能发现（递归 + Agent Skills 规范目录）', () => {
  it('递归扫描引擎目录、项目 .pi/skills 与祖先 .agents/skills', async () => {
    const agentDir = makeTempDir()
    mkdirSync(join(agentDir, 'skills', 'nested', 'deep'), { recursive: true })
    writeFileSync(join(agentDir, 'skills', 'nested', 'deep', 'SKILL.md'), '---\nname: deep-skill\ndescription: buried\n---\nbody', 'utf8')

    const root = makeTempDir()
    const project = join(root, 'repo')
    mkdirSync(join(project, '.pi', 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(project, '.pi', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n', 'utf8')
    mkdirSync(join(project, '.agents', 'skills', 'beta', 'inner'), { recursive: true })
    writeFileSync(join(project, '.agents', 'skills', 'beta', 'inner', 'SKILL.md'), '---\nname: beta\n---\n', 'utf8')
    mkdirSync(join(root, '.agents', 'skills', 'gamma'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills', 'gamma', 'SKILL.md'), '---\nname: gamma\n---\n', 'utf8')
    // 仓库根标记：祖先向上扫描到 root 即停
    writeFileSync(join(root, '.git'), '', 'utf8')

    const service = new EngineSkillService(stubDiscovery({ pi: { ready: true, agentDir } }))
    const snap = await service.getSnapshot('pi', project)
    const names = snap.skills.map((s) => s.name)
    expect(names).toContain('deep-skill')
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
    expect(names).toContain('gamma')
    const deep = snap.skills.find((s) => s.name === 'deep-skill')
    expect(deep?.originLabel).toBe('Pi 用户级技能目录')
    const beta = snap.skills.find((s) => s.name === 'beta')
    expect(beta?.originLabel).toContain('.agents/skills')
    expect(beta?.executable).toBe(true)
    // 白名单预览只放行发现结果
    expect(() => service.readSkillFile(join(root, 'not-discovered.md'))).toThrow('无法预览')
    expect(service.readSkillFile(deep!.filePath).content).toContain('body')
  })

  it('Prime：项目 Markdown 指令标记为不可斜杠调用', async () => {
    const agentDir = makeTempDir()
    const project = makeTempDir()
    writeFileSync(join(project, 'AGENTS.md'), '# instructions', 'utf8')
    const service = new EngineSkillService(stubDiscovery({ prime: { ready: true, agentDir } }))
    const snap = await service.getSnapshot('prime', project)
    const instruction = snap.skills.find((s) => s.name === 'AGENTS.md')
    expect(instruction).toBeDefined()
    expect(instruction?.origin).toBe('instruction')
    expect(instruction?.executable).toBe(false)
  })
})

describe('CLI 输出解析', () => {
  it('parsePiMcpListJson 提取服务器状态与错误', () => {
    const parsed = parsePiMcpListJson(JSON.stringify({
      servers: [
        { name: 'a', state: 'connected', tools: [{}, {}] },
        { name: 'b', status: 'error', error: 'boom' },
      ],
      errors: ['top-level'],
    }))
    expect(parsed.live.a).toEqual({ state: 'connected', toolCount: 2, error: undefined })
    expect(parsed.live.b?.state).toBe('error')
    expect(parsed.errors).toEqual(['top-level'])
    expect(parsePiMcpListJson('not json').errors).toHaveLength(1)
  })

  it('parseOmpPluginListJson 解析 npm 与 marketplace 两类', () => {
    const parsed = parseOmpPluginListJson(JSON.stringify({
      npm: [{ name: 'omp-git', version: '1.2.0', scope: 'project', description: 'git tools', features: ['commit', 'review'] }],
      marketplace: [{ name: 'web-tools', path: 'C:\\plugins\\web' }],
    }))
    expect(parsed.packages).toHaveLength(2)
    expect(parsed.packages[0]).toMatchObject({ name: 'omp-git', manager: 'npm', scope: 'project', resources: ['commit', 'review'] })
    expect(parsed.packages[1]).toMatchObject({ manager: 'marketplace', scope: 'user', path: 'C:\\plugins\\web' })
  })

  it('parsePlainPackageList 解析 pi / prime 文本列表', () => {
    const pi = parsePlainPackageList('Installed packages:\n- npm:@scope/first 1.0.0\n- git:github.com/user/repo\n- ./local/path\n', 'pi')
    expect(pi.map((p) => p.id)).toEqual(['npm:@scope/first', 'git:github.com/user/repo', './local/path'])
    expect(pi[0]?.version).toBe('1.0.0')
    expect(pi[0]?.manager).toBe('npm')
    expect(parsePlainPackageList('No packages installed.\n', 'prime')).toHaveLength(0)
    const prime = parsePlainPackageList('• my-pkg 0.2.1\n', 'prime')
    expect(prime[0]?.name).toBe('my-pkg')
  })

  it('parseOmpSkillListJson 解析跨引擎来源', () => {
    const parsed = parseOmpSkillListJson(JSON.stringify({
      skills: [
        { name: 'pdf-tools', description: 'pdf', filePath: 'C:\\s\\pdf\\SKILL.md', baseDir: 'C:\\s\\pdf', source: 'claude:user', hide: false },
        { name: 'builtin', filePath: 'C:\\s\\builtin', source: 'omp:user' },
      ],
      warnings: ['w1'],
    }))
    expect(parsed.skills).toHaveLength(2)
    expect(parsed.skills[0]).toMatchObject({ origin: 'engine-dir', originLabel: 'claude:user', executable: true })
    expect(parsed.errors).toEqual(['w1'])
  })

  it('parseSkillFrontmatter 提取 name/description', () => {
    const meta = parseSkillFrontmatter('---\nname: my-skill\ndescription: "Does things"\n---\n# body')
    expect(meta).toEqual({ name: 'my-skill', description: 'Does things' })
    expect(parseSkillFrontmatter('# no frontmatter')).toEqual({})
  })
})

describe('用量提取与去重聚合', () => {
  const piLine = (id: string, input: number, output: number, cost: number, ts: string) =>
    JSON.stringify({
      type: 'message', id,
      message: {
        role: 'assistant', model: 'glm-5.3', timestamp: ts,
        usage: { input, output, cacheRead: 10, cacheWrite: 5, totalTokens: input + output + 15, cost: { total: cost } },
      },
    })

  it('extractUsageRecordsFromSession 支持 Pi 与 Claude 两种记录', () => {
    const piContent = [piLine('e1', 100, 20, 0.01, '2026-11-20T10:00:00Z'), piLine('e2', 50, 5, 0, '2026-11-20T11:00:00Z')].join('\n')
    const piRecords = extractUsageRecordsFromSession('s.jsonl', piContent, { engine: 'pi', threadId: 't1', projectId: 'p1' })
    expect(piRecords).toHaveLength(2)
    expect(piRecords[0]).toMatchObject({ key: 'pi:e1', totalTokens: 135, costTotal: 0.01, date: '2026-11-20' })

    const claudeContent = JSON.stringify({
      uuid: 'u1', type: 'assistant',
      message: { role: 'assistant', model: 'sonnet', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      timestamp: '2026-11-19T08:00:00Z',
    })
    const claudeRecords = extractUsageRecordsFromSession('c.jsonl', claudeContent, { engine: 'claude', threadId: 't2', projectId: null })
    expect(claudeRecords).toHaveLength(1)
    expect(claudeRecords[0]).toMatchObject({ key: 'claude:u1', input: 10, output: 3, costTotal: null, date: '2026-11-19' })
  })

  it('aggregateUsage 按 key 去重并支持筛选；无费用时统一为 null', () => {
    const base: Array<UsageRecord> = [
      { key: 'pi:e1', engine: 'pi', projectId: 'p1', threadId: 't1', sessionPath: 'a', date: '2026-11-20', timestamp: null, model: 'glm-5.3', input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, costTotal: 0.01 },
      { key: 'pi:e1', engine: 'pi', projectId: 'p1', threadId: 't2', sessionPath: 'fork', date: '2026-11-20', timestamp: null, model: 'glm-5.3', input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, costTotal: 0.01 },
      { key: 'omp:x', engine: 'omp', projectId: 'p1', threadId: 't3', sessionPath: 'b', date: '2026-11-19', timestamp: null, model: 'gpt-5.2', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, costTotal: null },
    ]
    const result = aggregateUsage(base)
    expect(result.totals.totalTokens).toBe(132)
    expect(result.totals.calls).toBe(2)
    expect(result.totals.costTotal).toBe(0.01)
    // 混合费用数据：1/2 次调用带费用 → costCalls 让 UI 能标注「部分」
    expect(result.totals.costCalls).toBe(1)
    expect(result.byProject).toHaveLength(1)
    expect(result.byProject[0]?.engines).toEqual({ pi: 120, omp: 12 })
    expect(result.byProject[0]?.costCalls).toBe(1)
    expect(result.sessions.map((s) => s.threadId).sort()).toEqual(['t1', 't3'])
    const sessionT1 = result.sessions.find((s) => s.threadId === 't1')
    expect(sessionT1).toMatchObject({ costCalls: 1, calls: 1, costTotal: 0.01 })
    const missingCost = { costCalls: 0, calls: 1, costTotal: null }
    expect(result.sessions.find((s) => s.threadId === 't3')).toMatchObject(missingCost)
    expect(result.byDay.find((row) => row.date === '2026-11-19')).toMatchObject(missingCost)
    expect(result.byModel.find((row) => row.engine === 'omp')).toMatchObject(missingCost)
    expect(aggregateUsage(base, { engine: 'omp' }).totals).toMatchObject(missingCost)

    const filtered = aggregateUsage(base, { from: '2026-11-20', engine: 'pi' })
    expect(filtered.totals.totalTokens).toBe(120)
    const noCost = aggregateUsage([{ ...base[0], costTotal: null }])
    expect(noCost.totals.costTotal).toBeNull()
    expect(noCost.totals.costCalls).toBe(0)
    const fullCost = aggregateUsage([base[0]])
    expect(fullCost.totals).toMatchObject({ costCalls: 1, calls: 1, costTotal: 0.01 })
    expect(aggregateUsage([{ ...base[0], costTotal: 0 }]).totals).toMatchObject({ costCalls: 1, calls: 1, costTotal: 0 })
  })
})

describe('引擎统计解析', () => {
  it('parseOmpStatsJson 提取 overall', () => {
    const stats = parseOmpStatsJson(JSON.stringify({ overall: { totalRequests: 12, totalInputTokens: 1000, totalOutputTokens: 200, totalCacheReadTokens: 30, totalCacheWriteTokens: 4, totalCost: 0.5 } }))
    expect(stats).toMatchObject({ engine: 'omp', available: true, requests: 12, cost: 0.5 })
    expect(parseOmpStatsJson('nope')).toBeNull()
  })

  it('parseOmpUsageJson 提取 provider 报告', () => {
    const quota = parseOmpUsageJson(JSON.stringify({ reports: [{ provider: 'anthropic', label: 'Claude Max', usedPercent: 42.4 }], capacity: {} }))
    expect(quota.available).toBe(true)
    expect(quota.providers[0]).toMatchObject({ provider: 'anthropic', usedPercent: 42.4 })
    const empty = parseOmpUsageJson(JSON.stringify({ reports: [] }))
    expect(empty.available).toBe(false)
    expect(empty.note).toContain('没有')
  })

  it('parsePrimeSessionsJson 汇总会话用量；无数据返回 null', () => {
    const parsed = parsePrimeSessionsJson(JSON.stringify([
      { id: 'a', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cost: 0.02 } },
      { id: 'b', usage: { inputTokens: 50, outputTokens: 5 } },
    ]))
    expect(parsed.usage).toMatchObject({ engine: 'prime', available: true, requests: 2, inputTokens: 150, outputTokens: 15, cost: 0.02 })
    expect(parsePrimeSessionsJson(JSON.stringify([])).usage).toBeNull()
  })
})

describe('浏览器地址栏规范化', () => {
  it('无协议自动补 https，localhost 补 http，非法输入原样返回', () => {
    expect(normalizeUrlInput('example.com')).toBe('https://example.com')
    expect(normalizeUrlInput('example.com/path?a=1')).toBe('https://example.com/path?a=1')
    expect(normalizeUrlInput('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrlInput('https://example.com')).toBe('https://example.com')
    expect(normalizeUrlInput('about:blank')).toBe('about:blank')
    expect(normalizeUrlInput('not a url!')).toBe('not a url!')
    expect(normalizeUrlInput('')).toBe('')
  })
})

function stubDiscovery(entries: Partial<Record<HarnessId, Partial<HarnessStatus> & { ready?: boolean }>>): HarnessDiscoveryService {
  const empty = (id: HarnessId): HarnessStatus => ({
    id, name: id.toUpperCase(), path: null, version: null, ready: false, agentDir: '', sessionRoot: '',
  })
  const statuses = Object.fromEntries(
    (['pi', 'omp', 'prime'] as HarnessId[]).map((id) => {
      const provided = entries[id] ?? {}
      const ready = provided.ready ?? false
      return [id, { ...empty(id), ...provided, ready } satisfies HarnessStatus]
    }),
  ) as Record<HarnessId, HarnessStatus>
  return { snapshot: () => structuredClone(statuses) } as unknown as HarnessDiscoveryService
}

void existsSync
