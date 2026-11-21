import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentUiApi } from '../../src/shared/types'

const ROOT = resolve(process.cwd())
const require = createRequire(join(ROOT, 'package.json'))
const electronExecutable = require('electron') as string

interface E2EContext {
  app: ElectronApplication
  page: Page
  tempDir: string
  projectDir: string
  consoleErrors: string[]
  pageErrors: string[]
}

async function launchIsolatedApp(): Promise<E2EContext> {
  const tempDir = mkdtempSync(join(tmpdir(), 'agentui-e2e-'))
  const projectDir = join(tempDir, 'sample-repo')
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# Sample E2E Repo\n', 'utf8')
  writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const greeting = "hello agentui"\n', 'utf8')

  // Seed a Pi-style JSONL session so full-text search can index and open it end-to-end.
  const sessionPath = join(tempDir, 'seeded-session.jsonl')
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: 'session', id: 'e2e-sess-1', cwd: projectDir }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: '请帮我排查 quantum_flux_capacitor 超时问题' }] },
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: '已定位到重试退避配置过短，建议调大上限。' }] },
      }),
    ].join('\n'),
    'utf8',
  )

  const now = Date.now()
  const statePath = join(tempDir, 'state.json')
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        projects: [
          {
            id: 'e2e-proj-1',
            name: 'sample-repo',
            path: projectDir,
            addedAt: now,
            defaultHarness: 'pi',
            trustPreset: 'approval',
          },
        ],
        threads: [
          {
            id: 'e2e-thread-1',
            projectId: 'e2e-proj-1',
            title: 'E2E 初始会话',
            harness: 'pi',
            cwd: projectDir,
            sessionPath,
            thinkingLevel: 'medium',
            createdAt: now,
            updatedAt: now,
            status: 'idle',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  env.AGENTUI_STATE_PATH = statePath
  delete env.ELECTRON_RENDERER_URL

  const packagedExe = process.env.AGENTUI_E2E_EXECUTABLE?.trim()
  const app = await electron.launch(
    packagedExe
      ? { executablePath: packagedExe, env }
      : { executablePath: electronExecutable, args: [ROOT], env },
  )

  const page = await app.firstWindow()
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })

  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.app-shell', { timeout: 20_000 })
  return { app, page, tempDir, projectDir, consoleErrors, pageErrors }
}

test.describe('AgentUI Electron E2E regression', () => {
  let ctx: E2EContext | null = null

  test.beforeAll(async () => {
    ctx = await launchIsolatedApp()
  })

  test.afterAll(async () => {
    if (ctx) {
      await ctx.app.close().catch(() => undefined)
      rmSync(ctx.tempDir, { recursive: true, force: true })
      ctx = null
    }
  })

  test('boots cleanly with preload API, sandboxed renderer, and production CSP', async () => {
    const { page } = ctx!
    const apiMethods = await page.evaluate(() => {
      const api = (globalThis as unknown as { agentui?: AgentUiApi }).agentui
      return api ? Object.keys(api) : []
    })
    expect(apiMethods.length).toBeGreaterThanOrEqual(80)
    expect(apiMethods).toContain('searchSessions')
    expect(apiMethods).toContain('setProjectTrust')
    expect(apiMethods).toContain('browserWindowShow')
    expect(apiMethods).toContain('herdrStatus')

    // Confirm production CSP meta tag is injected with strict script-src 'self' and sandbox isolates Node globals
    const security = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { querySelector: (s: string) => { getAttribute: (k: string) => string | null } | null } }).document
      const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
      const g = globalThis as unknown as Record<string, unknown>
      return {
        csp,
        hasNodeRequire: typeof g.require !== 'undefined',
        hasNodeProcess: typeof g.process !== 'undefined',
      }
    })
    expect(security.csp).toContain("script-src 'self'")
    expect(security.csp).not.toContain('unsafe-eval')
    expect(security.csp).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(security.hasNodeRequire).toBe(false)
    expect(security.hasNodeProcess).toBe(false)
    expect(ctx!.pageErrors).toEqual([])
  })

  test('persists project trust presets and rejects invalid presets', async () => {
    const { page } = ctx!
    const updated = await page.evaluate(async () => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      const proj = await api.setProjectTrust('e2e-proj-1', 'readonly')
      const state = await api.getState()
      const persisted = state.projects.find((p) => p.id === 'e2e-proj-1')?.trustPreset
      let rejected = false
      try {
        await api.setProjectTrust('e2e-proj-1', 'invalid-preset' as never)
      } catch {
        rejected = true
      }
      await api.setProjectTrust('e2e-proj-1', 'approval')
      return { direct: proj.trustPreset, persisted, rejected }
    })
    expect(updated).toEqual({ direct: 'readonly', persisted: 'readonly', rejected: true })
  })

  test('lists workspace files, previews code, and blocks path traversal', async () => {
    const { page, projectDir } = ctx!
    const res = await page.evaluate(async (cwd) => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      const entries = await api.listWorkspaceDir(cwd)
      const file = await api.readWorkspaceFile(cwd, 'src/index.ts')
      let escaped = false
      try {
        await api.readWorkspaceFile(cwd, '../state.json')
        escaped = true
      } catch {
        escaped = false
      }
      return { names: entries.map((e) => e.name), content: file.content, language: file.language, escaped }
    }, projectDir)

    expect(res.names).toContain('src')
    expect(res.names).toContain('README.md')
    expect(res.content).toContain('hello agentui')
    expect(res.language).toBe('typescript')
    expect(res.escaped).toBe(false)
  })

  test('runs a command in the zero-native embedded terminal and captures output + exit', async () => {
    const { page, projectDir } = ctx!
    const result = await page.evaluate(async (cwd) => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      return await new Promise<{ output: string; code: number | null }>((resolvePromise, reject) => {
        let output = ''
        let targetId = ''
        const earlyOut = new Map<string, string>()
        const unsubOut = api.onTerminalOutput((ev) => {
          if (targetId && ev.runId === targetId) output += ev.text
          else earlyOut.set(ev.runId, (earlyOut.get(ev.runId) ?? '') + ev.text)
        })
        const finish = (code: number | null) => {
          unsubOut()
          unsubExit()
          resolvePromise({ output, code })
        }
        const earlyExit = new Map<string, number | null>()
        const unsubExit = api.onTerminalExit((ev) => {
          if (targetId && ev.runId === targetId) finish(ev.code)
          else earlyExit.set(ev.runId, ev.code)
        })
        api
          .terminalStart(cwd, 'echo AGENTUI_E2E_OK')
          .then((runId) => {
            targetId = runId
            output += earlyOut.get(runId) ?? ''
            if (earlyExit.has(runId)) finish(earlyExit.get(runId) ?? null)
          })
          .catch((err) => {
            unsubOut()
            unsubExit()
            reject(err)
          })
      })
    }, projectDir)

    expect(result.code).toBe(0)
    expect(result.output).toContain('AGENTUI_E2E_OK')
  })

  test('searches full-text session history in Command Palette and opens matching session', async () => {
    const { page } = ctx!
    await page.click('.sidebar-search')
    const input = page.locator('.palette-search input')
    await expect(input).toBeVisible()
    await input.fill('quantum_flux_capacitor')

    const ftsBar = page.locator('.palette-fts-bar')
    await expect(ftsBar).toContainText('命中 1 条')

    const hitOption = page.locator('.palette-results button', { hasText: 'E2E 初始会话' }).filter({ hasText: '全文' })
    await expect(hitOption).toBeVisible()
    await expect(hitOption).toContainText('quantum_flux_capacitor')

    await hitOption.click()
    await expect(page.locator('.command-palette')).toHaveCount(0)
    await expect(page.locator('.timeline-scroll')).toContainText('quantum_flux_capacitor')
  })

  test('opens Settings page and navigates key sections cleanly', async () => {
    const { page } = ctx!
    await page.locator('button[aria-label="设置"], button[title*="设置"]').first().click()
    await expect(page.locator('.settings-sidebar')).toBeVisible()

    for (const label of ['MCP 服务器', '插件', '技能', '使用情况', '浏览器', 'Herdr', '外观与布局']) {
      const navBtn = page.locator('.settings-sidebar button', { hasText: label }).first()
      await expect(navBtn).toBeVisible()
      await navBtn.click()
    }

    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-sidebar')).toHaveCount(0)
  })

  test('opens standalone browser window and validates share target check', async () => {
    const { app, page } = ctx!
    const windowCountBefore = app.windows().length
    await page.evaluate(async () => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      await api.browserWindowShow()
    })

    await expect.poll(() => app.windows().length).toBeGreaterThan(windowCountBefore)
    const browserWin = app.windows().find((w) => w.url().includes('browser.html'))
    expect(browserWin).toBeTruthy()
    await browserWin!.waitForLoadState('domcontentloaded')
    await expect(browserWin!.locator('input')).toBeVisible()

    const shareRejected = await browserWin!.evaluate(async () => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      try {
        await api.browserWinShare({ threadId: 'non-existent-thread', kind: 'link' })
        return false
      } catch {
        return true
      }
    })
    expect(shareRejected).toBe(true)

    await browserWin!.close()
    expect(ctx!.consoleErrors).toEqual([])
    expect(ctx!.pageErrors).toEqual([])
  })
})
