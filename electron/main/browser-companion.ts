import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, win32, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type {
  BrowserEgoStatus,
  BrowserMcpServer,
  BrowserOpenResult,
  BrowserScreenshotResult,
  BrowserSpaceInfo,
  BrowserStatus,
  BrowserTabInfo,
} from '@shared/types'
import {
  findRunnableCandidate,
  isAbsoluteForPlatform,
  killProcessTree,
  prepareExecutableSpawn,
  safeChildEnvironment,
} from './process-utils'

const RESULT_MARKER = 'AGENTUI_BROWSER_RESULT:'
const SPACE_NAME = 'agentui-workbench'
const BROWSER_MCP_PATTERN = /browser|playwright|puppeteer|chrome|chromium|\bego\b|ego-|browsermcp|browser-use/i
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024
const STATUS_CACHE_MS = 60_000

/** Classify an MCP server entry as browser-like based on name/command/args/url. */
export function isBrowserLikeMcp(entry: { name: string; command?: string; args?: string[]; url?: string }): boolean {
  const haystack = [entry.name, entry.command ?? '', ...(entry.args ?? []), entry.url ?? ''].join(' ')
  return BROWSER_MCP_PATTERN.test(haystack)
}

export interface McpConfigFile {
  source: string
  kind: 'json' | 'toml'
  content: string
}

function normalizeServerEntry(
  source: string,
  name: string,
  raw: unknown,
): BrowserMcpServer | null {
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

function parseCodexMcpToml(source: string, content: string): BrowserMcpServer[] {
  const servers: BrowserMcpServer[] = []
  let current: { name: string; command?: string; args?: string[]; url?: string } | null = null
  let inSubTable = false
  const flush = () => {
    if (current && (current.command || current.url)) {
      servers.push({ source, ...current, browserLike: isBrowserLikeMcp(current) })
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
): BrowserMcpServer[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const allowed = projectPaths ? new Set(projectPaths.map(norm)) : null
  const servers: BrowserMcpServer[] = []
  for (const file of files) {
    if (file.kind === 'toml') {
      servers.push(...parseCodexMcpToml(file.source, file.content))
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

export function egoExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const names = platform === 'win32' ? ['ego-browser.exe', 'ego-browser.cmd', 'ego-browser'] : ['ego-browser']
  const pathDirs = (platform === 'win32' ? [env.Path, env.PATH] : [env.PATH])
    .flatMap((v) => (v ?? '').split(platform === 'win32' ? ';' : ':'))
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => isAbsoluteForPlatform(d, platform))
  const extraDirs = [
    pathApi.join(home, '.local', 'share', 'ego', 'active_version_dir'),
    pathApi.join(home, '.local', 'bin'),
  ]
  const candidates: string[] = []
  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const name of names) candidates.push(pathApi.join(dir, name))
  }
  return candidates
}

/** Script preamble: resume (or create) the dedicated workbench space and resolve a usable page. */
const SPACE_PREAMBLE = `
const entries = await listTaskSpaces();
const entry = entries.find((s) => s.name === ${JSON.stringify(SPACE_NAME)});
const task = !entry
  ? await taskSpace(${JSON.stringify(SPACE_NAME)})
  : entry.ownership === 'user'
    ? await claimTaskSpace(entry.id)
    : entry.ownership === 'agentDelegatedToUser'
      ? await takeOverTaskSpace(entry.id)
      : await taskSpace(entry.id);
// Prefer the page that is the active tab (what the user is looking at) over pages[0].
let page;
{
  const pageList = await task.pages();
  const tabList = await task.tabs();
  const activeTab = tabList.find((t) => t.active);
  if (activeTab) {
    for (const p of pageList) {
      try { if ((await p.url()) === activeTab.url) { page = p; break; } } catch {}
    }
  }
  page = page ?? pageList[0];
}
if (!page) {
  const tabs = await task.tabs();
  page = tabs[0] ? await task.adopt(tabs[0].page) : await task.newPage();
}
`

function emitResult(expr: string): string {
  return `console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(await (${expr})));\n`
}

const TABS_EXPR = `(async () => (await task.tabs()).map((t) => ({ label: t.label, title: t.title, url: t.url, active: t.active })))()`

export class BrowserCompanionService {
  private egoCache: { status: BrowserEgoStatus; fetchedAt: number } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly getProjectPaths: () => string[] = () => []) {}

  async getStatus(refresh = false): Promise<BrowserStatus> {
    const ego = await this.detectEgo(refresh)
    const mcpServers = this.scanMcpConfigs()
    return { ego, mcpServers, fetchedAt: Date.now() }
  }

  private async detectEgo(refresh: boolean): Promise<BrowserEgoStatus> {
    if (!refresh && this.egoCache && Date.now() - this.egoCache.fetchedAt < STATUS_CACHE_MS) {
      return this.egoCache.status
    }
    const path = findRunnableCandidate(egoExecutableCandidates())
    let status: BrowserEgoStatus
    if (!path) {
      status = { available: false, path: null, version: null, error: '未找到 ego-browser CLI（可选组件）' }
    } else {
      try {
        const version = await this.probeVersion(path)
        status = { available: true, path, version }
      } catch (err) {
        status = {
          available: false,
          path,
          version: null,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
    this.egoCache = { status, fetchedAt: Date.now() }
    return status
  }

  private probeVersion(path: string): Promise<string | null> {
    return new Promise((resolvePromise, reject) => {
      let invocation
      try {
        invocation = prepareExecutableSpawn(path, ['--version'], safeChildEnvironment())
      } catch (err) {
        reject(err)
        return
      }
      const child = spawn(invocation.file, invocation.args, {
        env: invocation.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let settled = false
      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        if (child.pid) void killProcessTree(child.pid)
        done(() => reject(new Error('ego-browser --version 探测超时')))
      }, 10_000)
      timer.unref()
      child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
      child.stderr.on('data', (c: Buffer) => { out += c.toString('utf8') })
      child.once('error', (err) => done(() => reject(err)))
      child.once('close', (code) => {
        done(() => {
          if (code !== 0) {
            reject(new Error(`ego-browser --version 退出码 ${code}`))
            return
          }
          const match = out.match(/\d+(?:\.\d+)+/)
          resolvePromise(match ? match[0] : out.trim().slice(0, 40) || null)
        })
      })
    })
  }

  private scanMcpConfigs(): BrowserMcpServer[] {
    const home = homedir()
    const files: McpConfigFile[] = []
    const push = (source: string, kind: 'json' | 'toml') => {
      try {
        if (existsSync(source) && statSync(source).isFile()) {
          files.push({ source, kind, content: readFileSync(source, 'utf8') })
        }
      } catch {
        // unreadable config — skip
      }
    }
    push(join(home, '.claude.json'), 'json')
    push(join(home, '.codex', 'config.toml'), 'toml')
    push(join(home, '.gemini', 'settings.json'), 'json')
    for (const projectPath of this.getProjectPaths()) {
      push(join(projectPath, '.mcp.json'), 'json')
    }
    return parseMcpConfigFiles(files, this.getProjectPaths())
  }

  /** Serialize ego-browser script rounds: each invocation is a fresh process sharing one space. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async runScript<T>(body: string, timeoutMs = 60_000): Promise<T> {
    const ego = await this.detectEgo(false)
    if (!ego.available || !ego.path) {
      throw new Error(ego.error ?? 'ego-browser 不可用')
    }
    const dir = join(tmpdir(), 'agentui-browser')
    mkdirSync(dir, { recursive: true })
    const scriptPath = join(dir, `round-${Date.now()}-${randomUUID().slice(0, 8)}.mjs`)
    writeFileSync(scriptPath, body, 'utf8')
    const importUrl = pathToFileURL(scriptPath).href
    try {
      // ego-browser (Chromium-based) may route script console output to stderr
      // when stdio is piped, so search both streams for the result marker.
      const { stdout, stderr } = await this.spawnRound(ego.path, importUrl, timeoutMs)
      const combined = stdout.includes(RESULT_MARKER) ? stdout : stderr.includes(RESULT_MARKER) ? stderr : stdout
      const markerIndex = combined.lastIndexOf(RESULT_MARKER)
      if (markerIndex < 0) {
        throw new Error(`ego-browser 脚本未返回结果: ${(combined || stderr).slice(-400) || '(空输出)'}`)
      }
      const jsonText = combined.slice(markerIndex + RESULT_MARKER.length).split(/\r?\n/)[0]
      return JSON.parse(jsonText) as T
    } finally {
      try { rmSync(scriptPath, { force: true }) } catch { /* ignore */ }
    }
  }

  private spawnRound(executable: string, importUrl: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      let invocation
      try {
        invocation = prepareExecutableSpawn(
          executable,
          ['nodejs', '-e', `await import(${JSON.stringify(importUrl)})`],
          safeChildEnvironment(),
        )
      } catch (err) {
        reject(err)
        return
      }
      const child = spawn(invocation.file, invocation.args, {
        env: invocation.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        if (child.pid) void killProcessTree(child.pid)
        done(() => reject(new Error(`ego-browser 脚本超时（${Math.round(timeoutMs / 1000)}s）`)))
      }, timeoutMs)
      timer.unref()
      child.stdout.on('data', (c: Buffer) => {
        if (stdout.length < 4 * 1024 * 1024) stdout += c.toString('utf8')
      })
      child.stderr.on('data', (c: Buffer) => {
        if (stderr.length < 4 * 1024 * 1024) stderr += c.toString('utf8')
      })
      child.once('error', (err) => done(() => reject(err)))
      child.once('close', (code) => {
        done(() => {
          if (code !== 0 && !stdout.includes(RESULT_MARKER) && !stderr.includes(RESULT_MARKER)) {
            reject(new Error(`ego-browser 退出码 ${code}: ${(stderr || stdout).trim().slice(-500)}`))
            return
          }
          resolvePromise({ stdout, stderr })
        })
      })
    })
  }

  async listSpaces(): Promise<BrowserSpaceInfo[]> {
    return this.enqueue(async () => {
      const spaces = await this.runScript<Array<{ id: number; name: string; ownership?: string }>>(
        emitResult('listTaskSpaces()'),
        30_000,
      )
      return spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership }))
    })
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    return this.enqueue(async () => {
      const tabs = await this.runScript<Array<{ label?: string; title: string; url: string; active: boolean }>>(
        `${SPACE_PREAMBLE}\n${emitResult('task.tabs()')}`,
        30_000,
      )
      return tabs.map((t) => ({ label: t.label, title: t.title, url: t.url, active: t.active }))
    })
  }

  async openUrl(url: string): Promise<BrowserOpenResult> {
    const trimmed = url.trim()
    let parsedUrl: URL | null = null
    try {
      parsedUrl = new URL(trimmed)
    } catch {
      parsedUrl = null
    }
    if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || !parsedUrl.hostname) {
      throw new Error('仅支持 http(s) URL')
    }
    return this.enqueue(async () => {
      const script = `${SPACE_PREAMBLE}
await page.goto(${JSON.stringify(trimmed)});
await page.waitForLoadState().catch(() => {});
${emitResult(`(async () => ({ url: await page.url(), title: await page.title(), spaceId: task.spaceId, tabs: await ${TABS_EXPR} }))()`)}`
      return this.runScript<BrowserOpenResult>(script, 90_000)
    })
  }

  /** Make the tab with the given label the active one (one script round, returns the fresh tab list). */
  async activateTab(label: string): Promise<BrowserTabInfo[]> {
    if (typeof label !== 'string' || !label || label.length > 200) throw new Error('无效的标签页标识')
    return this.enqueue(async () => {
      const script = `${SPACE_PREAMBLE}
const wanted = ${JSON.stringify(label)};
const tabsNow = await task.tabs();
const target = tabsNow.find((t) => t.label === wanted);
if (!target) throw new Error('标签页不存在或已关闭');
let targetPage;
for (const p of await task.pages()) {
  try { if ((await p.url()) === target.url) { targetPage = p; break; } } catch {}
}
targetPage = targetPage ?? (await task.adopt(target.page));
if (typeof targetPage.bringToFront === 'function') await targetPage.bringToFront();
${emitResult(TABS_EXPR)}`
      const tabs = await this.runScript<Array<{ label?: string; title: string; url: string; active: boolean }>>(script, 30_000)
      return tabs.map((t) => ({ label: t.label, title: t.title, url: t.url, active: t.active }))
    })
  }

  async screenshot(): Promise<BrowserScreenshotResult> {
    return this.enqueue(async () => {
      const script = `${SPACE_PREAMBLE}
const shotPath = await page.screenshot();
${emitResult('(async () => ({ path: shotPath, url: await page.url(), title: await page.title() }))()')}`
      const result = await this.runScript<{ path: string; url: string; title: string }>(script, 60_000)
      if (!result.path || !existsSync(result.path)) {
        throw new Error('截图文件不存在')
      }
      const size = statSync(result.path).size
      if (size > MAX_SCREENSHOT_BYTES) {
        try { rmSync(result.path, { force: true }) } catch { /* ignore */ }
        throw new Error('截图超过 10MB 限制')
      }
      const data = readFileSync(result.path).toString('base64')
      try { rmSync(result.path, { force: true }) } catch { /* ignore */ }
      return { data, mimeType: 'image/png', url: result.url, title: result.title }
    })
  }
}