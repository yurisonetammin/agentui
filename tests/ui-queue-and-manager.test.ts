import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import { RuntimeManager } from '../electron/main/rpc/manager'
import { StateStore } from '../electron/main/store'
import type { ExtensionUiRequest, HarnessId, HarnessStatus, ThreadStatusUpdate } from '../src/shared/types'
import { dequeueUiRequest, enqueueUiRequest, pruneUiRequestsForThread } from '../src/shared/ui-queue'

function makeUiReq(id: string, threadId: string, title = 'Confirm'): ExtensionUiRequest {
  return {
    id,
    threadId,
    method: 'confirm',
    title,
  }
}

function makeStatuses(overrides: Partial<Record<HarnessId, Partial<HarnessStatus>>> = {}): Record<HarnessId, HarnessStatus> {
  return {
    pi: { id: 'pi', name: 'Pi', path: null, version: null, ready: false, error: 'Pi 未就绪', agentDir: '', sessionRoot: '', ...overrides.pi },
    omp: { id: 'omp', name: 'OMP', path: null, version: null, ready: false, error: 'OMP 未就绪', agentDir: '', sessionRoot: '', ...overrides.omp },
    prime: { id: 'prime', name: 'Prime Agent', path: null, version: null, ready: false, error: 'Prime Agent 未就绪', agentDir: '', sessionRoot: '', ...overrides.prime },
  }
}

describe('Extension UI queue & RuntimeManager', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    tempDirs.length = 0
  })

  it('queues, deduplicates, dequeues, and prunes ExtensionUiRequests per thread', () => {
    let queue: ExtensionUiRequest[] = []
    queue = enqueueUiRequest(queue, makeUiReq('r1', 't1', 'First'))
    queue = enqueueUiRequest(queue, makeUiReq('r2', 't2', 'Second'))
    queue = enqueueUiRequest(queue, makeUiReq('r1', 't1', 'First updated'))
    expect(queue.map((item) => `${item.id}:${item.title}`)).toEqual(['r1:First updated', 'r2:Second'])

    const pruned = pruneUiRequestsForThread(queue, 't1')
    expect(pruned.map((item) => item.id)).toEqual(['r2'])

    const empty = dequeueUiRequest(pruned, 'r2')
    expect(empty).toEqual([])
  })

  it('clears cached session timelines on removeThread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-mgr-'))
    tempDirs.push(dir)
    const sessionFile = join(dir, 'sess.jsonl')
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'Hello', timestamp: 1 } })}\n`,
      'utf8',
    )

    const store = new StateStore(join(dir, 'state.json'))
    store.mutate((draft) => {
      draft.threads.push({
        id: 't1',
        projectId: 'p1',
        title: 't1',
        harness: 'pi',
        cwd: dir,
        sessionPath: sessionFile,
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

    expect(manager.getTimeline('t1')).toHaveLength(1)
    writeFileSync(sessionFile, '', 'utf8')
    // Cached timeline remains even after file change until removeThread
    expect(manager.getTimeline('t1')).toHaveLength(1)

    await manager.removeThread('t1')
    expect(manager.getTimeline('t1')).toEqual([])
  })

  it('uses cached ready discovery snapshot and refreshes only when missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-disc-'))
    tempDirs.push(dir)

    const store = new StateStore(join(dir, 'state.json'))
    store.mutate((draft) => {
      draft.threads.push(
        {
          id: 't-miss',
          projectId: 'p1',
          title: 'miss',
          harness: 'pi',
          cwd: dir,
          thinkingLevel: 'medium',
          createdAt: 1,
          updatedAt: 1,
          status: 'idle',
        },
        {
          id: 't-cached',
          projectId: 'p1',
          title: 'cached',
          harness: 'omp',
          cwd: dir,
          thinkingLevel: 'medium',
          createdAt: 2,
          updatedAt: 2,
          status: 'idle',
        },
      )
    })

    let refreshCount = 0
    const statuses = makeStatuses({
      omp: { ready: true, path: join(dir, 'nonexistent-omp.exe') },
    })
    const stubDiscovery = {
      snapshot: () => statuses,
      refresh: async () => {
        refreshCount += 1
        return statuses
      },
    } as unknown as HarnessDiscoveryService

    const statusEvents: ThreadStatusUpdate[] = []
    const manager = new RuntimeManager(store, stubDiscovery, {
      onThreadEvent: () => undefined,
      onThreadStatus: (u) => statusEvents.push(u),
      onExtensionUiRequest: () => undefined,
    })

    await expect(manager.sendPrompt({ threadId: 't-miss', message: 'hi' })).rejects.toThrow('Pi 未就绪')
    expect(refreshCount).toBe(1)

    await expect(manager.sendPrompt({ threadId: 't-cached', message: 'hi' })).rejects.toThrow()
    expect(refreshCount).toBe(1)
    expect(statusEvents.some((u) => u.threadId === 't-cached' && u.status === 'error')).toBe(true)
  })

  it('tracks last user prompt and validates retryLastPrompt when none exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-retry-'))
    tempDirs.push(dir)
    const sessionFile = join(dir, 'sess.jsonl')
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'Fix lint errors', timestamp: 1 } })}\n`,
      'utf8',
    )

    const store = new StateStore(join(dir, 'state.json'))
    store.mutate((draft) => {
      draft.threads.push(
        {
          id: 't-empty',
          projectId: 'p1',
          title: 'empty',
          harness: 'pi',
          cwd: dir,
          thinkingLevel: 'medium',
          createdAt: 1,
          updatedAt: 1,
          status: 'idle',
        },
        {
          id: 't-session',
          projectId: 'p1',
          title: 'session',
          harness: 'pi',
          cwd: dir,
          sessionPath: sessionFile,
          thinkingLevel: 'medium',
          createdAt: 2,
          updatedAt: 2,
          status: 'disconnected',
        },
      )
    })

    const stubDiscovery = {
      snapshot: () => makeStatuses(),
      refresh: async () => makeStatuses(),
    } as unknown as HarnessDiscoveryService

    const statusEvents: ThreadStatusUpdate[] = []
    const manager = new RuntimeManager(store, stubDiscovery, {
      onThreadEvent: () => undefined,
      onThreadStatus: (u) => statusEvents.push(u),
      onExtensionUiRequest: () => undefined,
    })

    await expect(manager.retryLastPrompt('t-empty')).rejects.toThrow('没有可重试')
    expect(manager.getLastUserPrompt('t-session')).toBe('Fix lint errors')
    await expect(manager.retryLastPrompt('t-session')).rejects.toThrow('Pi 未就绪')
    expect(statusEvents.some((u) => u.threadId === 't-session' && u.disconnectInfo?.lastPrompt === 'Fix lint errors')).toBe(true)
  })
})
