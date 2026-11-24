import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatBrowserAnnotationForComposer } from '../src/shared/browser-annotation'
import { buildSideBySideDiffRows, parseUnifiedDiffLines } from '../src/shared/diff-lines'
import {
  isValidCronExpression,
  matchesCronDate,
  nextCronRun,
  parseCronExpression,
  parsePrimeScheduleListOutput,
  parsePrimeStatusOutput,
} from '../src/shared/scheduler'
import { extractSubagentInfo } from '../src/shared/subagent'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import { ScheduleService } from '../electron/main/schedule-service'
import { StateStore } from '../electron/main/store'
import { WorkspaceBrowserService } from '../electron/main/workspace-browser'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('P1 #4 Browser DOM element annotation formatter', () => {
  it('formats note, selector, dimensions, and text excerpt cleanly', () => {
    const md = formatBrowserAnnotationForComposer(
      {
        selector: '#checkout > button.primary:nth-of-type(1)',
        tag: 'button',
        id: '',
        classes: ['primary'],
        role: 'button',
        text: 'Submit Order Now',
        rect: { x: 120, y: 340, width: 164, height: 42, viewportWidth: 1280, viewportHeight: 800 },
        url: 'http://localhost:5173/cart',
        title: 'Checkout Page',
      },
      '按钮文字在窄屏下换行了，请加上 white-space: nowrap',
    )

    expect(md).toContain('按钮文字在窄屏下换行了')
    expect(md).toContain('[Checkout Page](http://localhost:5173/cart)')
    expect(md).toContain('`#checkout > button.primary:nth-of-type(1)`')
    expect(md).toContain('`<button>`')
    expect(md).toContain('164×42 @ (120, 340)')
    expect(md).toContain('Submit Order Now')
  })

  it('works without note or text excerpt', () => {
    const md = formatBrowserAnnotationForComposer(
      {
        selector: 'img.hero',
        tag: 'IMG',
        classes: ['hero'],
        text: '',
        rect: { x: 0, y: 0, width: 800, height: 300, viewportWidth: 1280, viewportHeight: 800 },
        url: 'https://example.com',
        title: '',
      },
      '   ',
    )
    expect(md).toMatch(/^> \*\*页面元素批注\*\*/)
    expect(md).toContain('`<img>`')
    expect(md).not.toContain('文本摘要')
  })
})

describe('P1 #5 Cron parser, Prime status parser, and ScheduleService', () => {
  it('validates and parses 5-field Cron expressions and presets', () => {
    expect(isValidCronExpression('*/15 * * * *')).toBe(true)
    expect(isValidCronExpression('30 9 * * 1-5')).toBe(true)
    expect(isValidCronExpression('0 0 1,15 * 0,7')).toBe(true)
    expect(isValidCronExpression('@daily')).toBe(true)
    expect(isValidCronExpression('@hourly')).toBe(true)
    expect(isValidCronExpression('@weekly')).toBe(true)

    expect(isValidCronExpression('60 * * * *')).toBe(false)
    expect(isValidCronExpression('0 9 * *')).toBe(false)
    expect(isValidCronExpression('foo bar * * *')).toBe(false)
    expect(isValidCronExpression('*/0 * * * *')).toBe(false)

    const parsed = parseCronExpression('30 9 * * 1-5')!
    expect(matchesCronDate(parsed, new Date(2026, 10, 23, 9, 30))).toBe(true) // Mon
    expect(matchesCronDate(parsed, new Date(2026, 10, 22, 9, 30))).toBe(false) // Sun
  })

  it('calculates nextCronRun accurately', () => {
    const base = new Date(2026, 10, 24, 9, 10, 0).getTime()
    const next15 = nextCronRun('*/15 * * * *', base)
    expect(next15).toBe(new Date(2026, 10, 24, 9, 15, 0).getTime())

    const nextDaily = nextCronRun('0 9 * * *', base)
    expect(nextDaily).toBe(new Date(2026, 10, 25, 9, 0, 0).getTime())
  })

  it('parses real Prime status and schedule list JSON outputs', () => {
    const daemons = parsePrimeStatusOutput(
      JSON.stringify([
        { socketPath: '\\\\.\\pipe\\prime-agent-daemon', status: 'unreachable', isDefault: true, hasTrackedWorkers: true },
      ]),
    )
    expect(daemons).toHaveLength(1)
    expect(daemons[0]!.status).toBe('unreachable')
    expect(daemons[0]!.hasTrackedWorkers).toBe(true)

    const native = parsePrimeScheduleListOutput(
      JSON.stringify([{ id: 's1', agent: 'main', cron: '0 9 * * *', prompt: 'daily check' }]),
    )
    expect(native).toHaveLength(1)
    expect(native[0]!.schedule).toBe('0 9 * * *')
    expect(native[0]!.prompt).toBe('daily check')
  })

  it('persists tasks, runs manually, notifies on failure, and deduplicates cron ticks', async () => {
    const root = makeTempDir('agentui-sched-')
    const projectDir = makeTempDir('agentui-sched-proj-')
    const store = new StateStore(join(root, 'state.json'))
    store.mutate((draft) => {
      draft.projects.push({
        id: 'proj-1',
        name: 'demo',
        path: projectDir,
        addedAt: Date.now(),
        defaultHarness: 'pi',
        trustPreset: 'readonly',
      })
    })

    const fakeDiscovery = { snapshot: () => ({ prime: { ready: false, path: null, version: null, agentDir: '', sessionRoot: '' } }) } as unknown as HarnessDiscoveryService
    const runTask = vi.fn(async () => ({ summary: '巡检完成：0 个错误' }))
    const onFailureNotify = vi.fn()

    const svc = new ScheduleService({
      store,
      discovery: fakeDiscovery,
      runTask,
      onFailureNotify,
    })

    const snap1 = svc.upsertTask({
      name: '每日巡检',
      cron: '30 9 * * *',
      projectId: 'proj-1',
      harness: 'pi',
      trustPreset: 'readonly',
      prompt: '检查 git status',
    })
    expect(snap1.tasks).toHaveLength(1)
    const taskId = snap1.tasks[0]!.id
    expect(snap1.nextRuns[taskId]).toBeTypeOf('number')

    // Tick at matching time fires once; repeating in the same minute is deduplicated.
    const fireTime = new Date(2026, 10, 24, 9, 30, 10)
    await svc.tick(fireTime)
    await svc.tick(new Date(2026, 10, 24, 9, 30, 40))
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(svc.snapshot().runs).toHaveLength(1)
    expect(svc.snapshot().runs[0]!.status).toBe('success')

    // Reload from disk preserves task & run history.
    const reloaded = new ScheduleService({ store, discovery: fakeDiscovery, runTask })
    expect(reloaded.snapshot().tasks).toHaveLength(1)
    expect(reloaded.snapshot().runs).toHaveLength(1)

    // Failure notifies user when notifyOnFailure is true.
    runTask.mockRejectedValueOnce(new Error('模拟 CLI 超时'))
    const failRec = await svc.runTaskNow(taskId)
    expect(failRec.status).toBe('error')
    expect(onFailureNotify).toHaveBeenCalledTimes(1)

    // Toggle & delete
    const paused = svc.toggleTask(taskId, false)
    expect(paused.tasks[0]!.enabled).toBe(false)
    expect(paused.nextRuns[taskId]).toBeNull()
    expect(svc.deleteTask(taskId).tasks).toHaveLength(0)
  })
})

describe('P1 #6 WorkspaceBrowserService.writeFile and Side-by-Side Diff', () => {
  it('saves files atomically inside workspace and blocks path escape', () => {
    const dir = makeTempDir('agentui-ws-edit-')
    const target = join(dir, 'hello.ts')
    writeFileSync(target, 'export const a = 1\n', 'utf8')

    const browser = new WorkspaceBrowserService()
    const res = browser.writeFile(dir, 'hello.ts', 'export const a = 2\n')
    expect(res.path).toBe('hello.ts')
    expect(readFileSync(target, 'utf8')).toBe('export const a = 2\n')

    expect(() => browser.writeFile(dir, '../escape.txt', 'bad')).toThrow(/路径越界/)
    expect(() => browser.writeFile(dir, 'hello.ts', 'x'.repeat(2 * 1024 * 1024 + 10))).toThrow(/超过保存上限/)
  })

  it('pairs deletions and additions cleanly in buildSideBySideDiffRows', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const x = 1',
      '-const oldVal = 2',
      '+const newVal = 3',
      '+const extra = 4',
      ' export { x }',
    ].join('\n')

    const parsed = parseUnifiedDiffLines(diff, 'src/a.ts')
    const rows = buildSideBySideDiffRows(parsed)
    const pairs = rows.filter((r) => r.type === 'pair')

    expect(pairs).toHaveLength(4)
    expect(pairs[0]!.left?.text).toBe('const x = 1')
    expect(pairs[0]!.right?.text).toBe('const x = 1')
    expect(pairs[1]!.left?.kind).toBe('del')
    expect(pairs[1]!.left?.text).toBe('const oldVal = 2')
    expect(pairs[1]!.right?.kind).toBe('add')
    expect(pairs[1]!.right?.text).toBe('const newVal = 3')
    expect(pairs[2]!.left).toBeNull()
    expect(pairs[2]!.right?.kind).toBe('add')
    expect(pairs[2]!.right?.text).toBe('const extra = 4')
    expect(pairs[3]!.left?.text).toBe('export { x }')
  })
})

describe('P1 #7 Subagent progress extraction', () => {
  it('recognizes Claude Task / OMP subagent calls and ignores regular tools', () => {
    const claudeTask = extractSubagentInfo({
      id: 't1',
      name: 'Task',
      argsText: '{}',
      args: {
        subagent_type: 'Explore',
        description: 'Inspect RPC bridges',
        prompt: 'Find all files in electron/main/rpc/bridges',
        model: 'claude-sonnet-4-5',
      },
      status: 'running',
      output: '',
      isError: false,
    })
    expect(claudeTask).not.toBeNull()
    expect(claudeTask?.role).toBe('Explore')
    expect(claudeTask?.description).toBe('Inspect RPC bridges')
    expect(claudeTask?.model).toBe('claude-sonnet-4-5')

    const ompSub = extractSubagentInfo({
      id: 't2',
      name: 'subagent',
      argsText: '{}',
      args: { role: 'Reviewer', task: 'Audit security boundaries' },
      status: 'success',
      output: 'Looks good',
      isError: false,
      durationMs: 2400,
    })
    expect(ompSub?.role).toBe('Reviewer')
    expect(ompSub?.description).toBe('Audit security boundaries')

    const regularBash = extractSubagentInfo({
      id: 't3',
      name: 'Bash',
      argsText: '{}',
      args: { command: 'npm test' },
      status: 'success',
      output: 'ok',
      isError: false,
    })
    expect(regularBash).toBeNull()
  })
})
