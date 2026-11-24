import { execFileSync } from 'node:child_process'
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
  execFileSync('git', ['init', '-b', 'main', projectDir], { stdio: 'ignore' })
  execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'E2E User'])
  execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'e2e@example.com'])
  execFileSync('git', ['-C', projectDir, 'add', '.'])
  execFileSync('git', ['-C', projectDir, 'commit', '-m', 'chore: initial commit'], { stdio: 'ignore' })
  writeFileSync(join(projectDir, 'README.md'), '# Sample E2E Repo\n\nUpdated line for diff review.\n', 'utf8')

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

    // Turn Navigator appears in header and lists the loaded user turn
    const turnTrigger = page.locator('.turn-nav-trigger')
    await expect(turnTrigger).toBeVisible()
    await expect(turnTrigger).toContainText('1 轮')
    await turnTrigger.click()
    const jumpBtn = page.locator('.turn-nav-jump').first()
    await expect(jumpBtn).toContainText('quantum_flux_capacitor')
    await jumpBtn.click()
  })

  test('persists fine-grained Allow/Ask/Deny permission rules and renders them in Settings', async () => {
    const { page } = ctx!
    await page.locator('button[aria-label="设置"], button[title*="设置"]').first().click()
    await expect(page.locator('.settings-sidebar')).toBeVisible()

    const permNav = page.locator('.settings-sidebar button', { hasText: '项目与权限' }).first()
    await permNav.click()

    const patternInput = page.locator('#projects-rules input[aria-label="规则匹配模式"]')
    await expect(patternInput).toBeVisible()
    await patternInput.fill('npm test*')
    await page.locator('#projects-rules button', { hasText: '添加规则' }).click()
    await expect(page.locator('.perm-rule-list')).toContainText('npm test*')

    const persistedCount = await page.evaluate(async () => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      const state = await api.getState()
      return state.projects.find((p) => p.id === 'e2e-proj-1')?.permissionRules?.length ?? 0
    })
    expect(persistedCount).toBe(1)

    // Clean up rule via UI delete button
    await page.locator('.perm-rule-row button[aria-label*="删除规则"]').first().click()
    await expect(page.locator('.perm-rule-row')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-sidebar')).toHaveCount(0)
  })

  test('annotates a Diff line range and injects formatted review comment into Composer', async () => {
    const { page } = ctx!
    const changesBtn = page.locator('.workspace-tools button[aria-label="变更"]')
    const pressed = await changesBtn.getAttribute('aria-pressed')
    if (pressed !== 'true') {
      await changesBtn.click()
    }
    await expect(page.locator('.git-delivery-bar')).toBeVisible()
    await expect(page.locator('.git-branch-name')).toHaveText('main')

    const gutter = page.locator('.diff-line.add .diff-gutter.is-selectable').first()
    await expect(gutter).toBeVisible()
    await gutter.click()

    const commentInput = page.locator('.diff-comment-input')
    await expect(commentInput).toBeVisible()
    await commentInput.fill('请润色这一行文案')
    await page.locator('.diff-comment-actions button.btn-primary').click()

    await expect(page.locator('.diff-comment-box')).toHaveCount(0)
    const composerVal = await page.locator('.composer-textarea').inputValue()
    expect(composerVal).toContain('@README.md#L')
    expect(composerVal).toContain('请润色这一行文案')
    expect(composerVal).toContain('```diff')

    // Switch to Side-by-Side Diff mode and verify split rows render cleanly
    const splitToggle = page.locator('.diff-viewer-bar button', { hasText: '并排' })
    await expect(splitToggle).toBeVisible()
    await splitToggle.click()
    await expect(page.locator('.diff-split-wrap')).toBeVisible()
    await expect(page.locator('.diff-split-row').first()).toBeVisible()
  })

  test('edits and saves a workspace file with CodeMirror 6 and lists external editors', async () => {
    const { page, projectDir } = ctx!
    const filesBtn = page.locator('.workspace-tools button[aria-label="文件"]')
    await filesBtn.click()
    await expect(page.locator('.ws-files-panel')).toBeVisible()

    // Open README.md in CodeMirror 6 editor
    await page.locator('.ws-tree-row', { hasText: 'README.md' }).click()
    await expect(page.locator('.ws-cm-wrap .cm-editor')).toBeVisible()

    // Verify workspace:writeFile & listExternalEditors IPC round-trip
    const editResult = await page.evaluate(async (cwd) => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      const editors = await api.listExternalEditors()
      const orig = await api.readWorkspaceFile(cwd, 'src/index.ts')
      const updated = `${orig.content}// edited-via-p1\n`
      await api.writeWorkspaceFile(cwd, 'src/index.ts', updated)
      const reread = await api.readWorkspaceFile(cwd, 'src/index.ts')
      // Restore original content so git state stays clean for other tests
      await api.writeWorkspaceFile(cwd, 'src/index.ts', orig.content)
      return {
        hasExplorer: editors.some((e) => e.id === 'explorer' && e.available),
        savedOk: reread.content.includes('edited-via-p1'),
      }
    }, projectDir)
    expect(editResult.hasExplorer).toBe(true)
    expect(editResult.savedOk).toBe(true)
  })

  test('opens Dual-Pane Split View and switches threads side by side', async () => {
    const { page } = ctx!
    await page.locator('.project-actions button[title*="新建对话"]').first().click()

    const splitBtn = page.locator('button[aria-label="开启双会话分屏"]')
    await expect(splitBtn).toBeEnabled()
    await splitBtn.click()
    await expect(page.locator('.split-thread-pane')).toBeVisible()
    await expect(page.locator('.split-pane-select')).toBeVisible()

    // Swap panes and close split view
    await page.locator('button[aria-label="与左侧主会话互换"]').click()
    await expect(page.locator('.split-thread-pane')).toBeVisible()
    await page.locator('button[aria-label="关闭分屏"]').click()
    await expect(page.locator('.split-thread-pane')).toHaveCount(0)
  })

  test('creates, toggles, and deletes a Cron scheduled task in Settings', async () => {
    const { page } = ctx!
    await page.locator('button[aria-label="设置"], button[title*="设置"]').first().click()
    await expect(page.locator('.settings-sidebar')).toBeVisible()

    const schedNav = page.locator('.settings-sidebar button', { hasText: '定时任务' }).first()
    await expect(schedNav).toBeVisible()
    await schedNav.click()
    await expect(page.locator('#schedules-create')).toBeVisible()
    await expect(page.locator('#schedules-prime')).toBeVisible()

    await page.locator('#schedules-create input[placeholder*="每日代码变更摘要"]').fill('E2E 每日巡检')
    await page.locator('#schedules-create textarea').fill('检查最近提交并输出摘要')
    await page.locator('#schedules-create button[type="submit"]').click()

    await expect(page.locator('.schedule-task-list')).toContainText('E2E 每日巡检')

    // Toggle task off then delete it
    await page.locator('.schedule-task-item button[role="switch"]').first().click()
    await expect(page.locator('.schedule-task-item')).toContainText('已暂停')
    await page.locator('.schedule-task-item button[aria-label*="删除任务"]').first().click()
    await expect(page.locator('.schedule-task-item')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-sidebar')).toHaveCount(0)
  })

  test('opens Settings page and navigates key sections cleanly', async () => {
    const { page } = ctx!
    await page.locator('button[aria-label="设置"], button[title*="设置"]').first().click()
    await expect(page.locator('.settings-sidebar')).toBeVisible()

    for (const label of ['MCP 服务器', '插件', '技能', '定时任务', '使用情况', '浏览器', 'Herdr', '外观与布局']) {
      const navBtn = page.locator('.settings-sidebar button', { hasText: label }).first()
      await expect(navBtn).toBeVisible()
      await navBtn.click()
    }

    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-sidebar')).toHaveCount(0)
  })

  test('opens standalone browser window, exposes element picker, and delivers DOM annotation to Composer', async () => {
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
    await expect(browserWin!.locator('button', { hasText: '点选批注' })).toBeVisible()

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

    // Deliver a structured DOM element annotation from the browser window to the active thread Composer
    await browserWin!.evaluate(async () => {
      const api = (globalThis as unknown as { agentui: AgentUiApi }).agentui
      await api.browserWinShareAnnotation({
        threadId: 'e2e-thread-1',
        note: '请修正该按钮圆角',
        element: {
          selector: '#submit-btn',
          tag: 'button',
          classes: ['primary'],
          text: '保存',
          rect: { x: 10, y: 20, width: 120, height: 36, viewportWidth: 1024, viewportHeight: 768 },
          url: 'http://localhost:5173/',
          title: 'Demo App',
        },
      })
    })
    await expect(page.locator('.composer-textarea')).toHaveValue(/#submit-btn/)
    await expect(page.locator('.composer-textarea')).toHaveValue(/请修正该按钮圆角/)

    await browserWin!.close()
    expect(ctx!.consoleErrors).toEqual([])
    expect(ctx!.pageErrors).toEqual([])
  })
})
