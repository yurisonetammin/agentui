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
import { isBrowserLikeMcp, parseMcpConfigFiles, type McpConfigFile } from '@shared/mcp-config'
import {
  findRunnableCandidate,
  isAbsoluteForPlatform,
  killProcessTree,
  prepareExecutableSpawn,
  safeChildEnvironment,
} from './process-utils'

// MCP 配置解析（含 Codex TOML）已抽到 @shared/mcp-config，这里 re-export 保持测试兼容。
export { isBrowserLikeMcp, parseMcpConfigFiles }
export type { McpConfigFile }

const RESULT_MARKER = 'AGENTUI_BROWSER_RESULT:'
const SPACE_NAME = 'agentui-workbench'
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024
const STATUS_CACHE_MS = 60_000

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