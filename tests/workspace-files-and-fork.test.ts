import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import { RuntimeManager } from '../electron/main/rpc/manager'
import { createForkedSessionFile, readSessionForkTree, readSessionTimeline } from '../electron/main/sessions/catalog'
import { StateStore } from '../electron/main/store'
import { WorkspaceFileService } from '../electron/main/workspace-files'
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId, type HarnessStatus } from '../src/shared/types'

function makeStatuses(): Record<HarnessId, HarnessStatus> {
  return Object.fromEntries(
    HARNESS_IDS.map((id) => [
      id,
      { id, name: HARNESS_LABELS[id], path: null, version: null, ready: false, agentDir: '', sessionRoot: '' },
    ]),
  ) as Record<HarnessId, HarnessStatus>
}

describe('WorkspaceFileService & Session Fork Tree', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('lists files in a non-git workspace while ignoring node_modules and out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-ws-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, 'out'), { recursive: true })
    writeFileSync(join(dir, 'src', 'App.tsx'), 'export const App = () => null\n', 'utf8')
    writeFileSync(join(dir, 'README.md'), '# hello\n', 'utf8')
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '', 'utf8')
    writeFileSync(join(dir, 'out', 'bundle.js'), '', 'utf8')

    const svc = new WorkspaceFileService()
    const all = await svc.listFiles(dir, '')
    expect(all.map((f) => f.path).sort()).toEqual(['README.md', 'src/App.tsx'])

    const filtered = await svc.listFiles(dir, 'app')
    expect(filtered[0]).toEqual({ path: 'src/App.tsx', name: 'App.tsx' })
  })

  it('reads session fork tree, forks before an entryId with parentSession, and clones full branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-fork-'))
    dirs.push(dir)
    const srcFile = join(dir, '2026-11-20_root.jsonl')

    const records = [
      { type: 'session', version: 3, id: 'root-sess', timestamp: '2026-11-20T10:00:00Z', cwd: dir },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-20T10:00:01Z', message: { role: 'user', content: 'Design API schema', timestamp: 1000 } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-20T10:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Proposed REST schema v1.' }], model: 'claude-sonnet-4', timestamp: 2000 } },
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-11-20T10:00:03Z', message: { role: 'user', content: 'Switch to GraphQL instead', timestamp: 3000 } },
      { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-11-20T10:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Switched to GraphQL.' }], model: 'claude-sonnet-4', timestamp: 4000 } },
    ]
    writeFileSync(srcFile, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

    const tree = readSessionForkTree(srcFile)
    expect(tree.leafId).toBe('a2')
    expect(tree.messages).toHaveLength(2)
    expect(tree.messages[0]).toMatchObject({
      entryId: 'u1',
      text: 'Design API schema',
      assistantPreview: 'Proposed REST schema v1.',
      model: 'claude-sonnet-4',
    })
    expect(tree.messages[1]).toMatchObject({
      entryId: 'u2',
      text: 'Switch to GraphQL instead',
      assistantPreview: 'Switched to GraphQL.',
    })

    // Fork at u2 keeps everything strictly BEFORE u2 (u1 + a1) and returns u2 text as prefillText
    const forked = createForkedSessionFile(srcFile, 'u2')
    expect(forked.prefillText).toBe('Switch to GraphQL instead')
    const forkedTimeline = readSessionTimeline(forked.sessionPath)
    expect(forkedTimeline).toHaveLength(2)
    expect(forkedTimeline[0].role === 'user' && forkedTimeline[0].text).toBe('Design API schema')

    // Clone full branch keeps all 4 messages
    const cloned = createForkedSessionFile(srcFile, null)
    expect(cloned.prefillText).toBeUndefined()
    expect(readSessionTimeline(cloned.sessionPath)).toHaveLength(4)

    // Verify RuntimeManager.forkThread('new-thread') wires parentThreadId & allows cross-engine fork
    const store = new StateStore(join(dir, 'state.json'))
    store.mutate((draft) => {
      draft.projects.push({ id: 'p1', name: 'demo', path: dir, addedAt: 1, defaultHarness: 'pi' })
      draft.threads.push({
        id: 't-root',
        projectId: 'p1',
        title: 'API Schema',
        harness: 'pi',
        cwd: dir,
        sessionPath: srcFile,
        thinkingLevel: 'medium',
        createdAt: 1,
        updatedAt: 1,
        status: 'idle',
      })
    })

    const stubDiscovery = {
      snapshot: () => makeStatuses(),
      refresh: async () => makeStatuses(),
    } as unknown as HarnessDiscoveryService

    const manager = new RuntimeManager(store, stubDiscovery, {
      onThreadEvent: () => undefined,
      onThreadStatus: () => undefined,
      onExtensionUiRequest: () => undefined,
    })

    const res = await manager.forkThread({
      threadId: 't-root',
      entryId: 'u2',
      mode: 'new-thread',
      harness: 'omp',
    })
    expect(res.prefillText).toBe('Switch to GraphQL instead')
    expect(res.thread.parentThreadId).toBe('t-root')
    expect(res.thread.forkedFromEntryId).toBe('u2')
    expect(res.thread.harness).toBe('omp')
    expect(manager.getTimeline(res.thread.id)).toHaveLength(2)
  })
})
