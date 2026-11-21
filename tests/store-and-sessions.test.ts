import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionTimeline, scanCliSessions } from '../electron/main/sessions/catalog'
import { StateStore } from '../electron/main/store'
import { DEFAULT_APPEARANCE, DEFAULT_CONVERSATION } from '../src/shared/settings'

describe('StateStore and CLI session catalog', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('persists and reloads state atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-store-'))
    dirs.push(dir)
    const file = join(dir, 'state.json')

    const s1 = new StateStore(file)
    s1.mutate((draft) => {
      draft.activeHarness = 'omp'
      draft.projects.push({ id: 'p1', name: 'demo', path: dir, addedAt: 1, defaultHarness: 'omp' })
    })

    const s2 = new StateStore(file)
    expect(s2.snapshot().activeHarness).toBe('omp')
    expect(s2.snapshot().projects).toHaveLength(1)
  })

  it('loads older state and persists appearance and per-engine defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-settings-'))
    dirs.push(dir)
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ activeHarness: 'omp' }))
    const store = new StateStore(file)
    expect(store.snapshot().appearance).toEqual(DEFAULT_APPEARANCE)
    expect(store.snapshot().conversation).toEqual(DEFAULT_CONVERSATION)
    expect(store.snapshot().defaultProjectTrust).toBe('approval')
    expect(store.snapshot().harnessDefaults).toEqual({})
    store.mutate((draft) => {
      draft.appearance = { ...draft.appearance, theme: 'dark', codeFontSize: 16, terminalPlacement: 'bottom' }
      draft.conversation = { enterWhileRunning: 'steer', collapseToolGroups: false }
      draft.defaultProjectTrust = 'readonly'
      draft.harnessDefaults.omp = { model: { provider: 'fixture', id: 'test-model' }, thinkingLevel: 'high' }
    })
    const reloaded = new StateStore(file).snapshot()
    expect(reloaded.appearance).toMatchObject({ theme: 'dark', codeFontSize: 16, terminalPlacement: 'bottom' })
    expect(reloaded.conversation).toEqual({ enterWhileRunning: 'steer', collapseToolGroups: false })
    expect(reloaded.defaultProjectTrust).toBe('readonly')
    expect(reloaded.harnessDefaults).toEqual({ omp: { model: { provider: 'fixture', id: 'test-model' }, thinkingLevel: 'high' } })
  })

  it('scans JSONL session files and reconstructs timeline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-sess-'))
    dirs.push(dir)
    const sub = join(dir, '--e-repo--')
    mkdirSync(sub, { recursive: true })
    const file = join(sub, '2026-11-18_abc.jsonl')

    const records = [
      { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-11-18T10:00:00Z', cwd: 'E:/repo' },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-11-18T10:00:01Z', message: { role: 'user', content: 'Fix bug #42', timestamp: 1000 } },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-11-18T10:00:02Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Checking logs' },
            { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'text', text: 'Fixed it.' },
          ],
          model: 'claude-sonnet-4',
          stopReason: 'stop',
          timestamp: 2000,
        },
      },
      {
        type: 'message',
        id: 'm3',
        parentId: 'm2',
        timestamp: '2026-11-18T10:00:03Z',
        message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false, timestamp: 3000 },
      },
    ]
    writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

    const summaries = scanCliSessions('pi', dir)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      harness: 'pi',
      sessionId: 'sess-1',
      cwd: 'E:/repo',
      title: 'Fix bug #42',
    })

    const timeline = readSessionTimeline(file)
    expect(timeline).toHaveLength(2)
    expect(timeline[1].role).toBe('assistant')
    if (timeline[1].role === 'assistant') {
      expect(timeline[1].toolCalls.tc1.output).toBe('file body')
    }
  })
})
