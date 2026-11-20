import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExtensionUiRequest, ExtensionUiResponse, ThreadEventEnvelope, ThreadStatusUpdate } from '../src/shared/types'
import type { TrustPreset } from '../src/shared/tool-policy'
import { StateStore } from '../electron/main/store'
import { RuntimeManager } from '../electron/main/rpc/manager'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import type { RpcRuntime } from '../electron/main/rpc/runtime'

interface Harness {
  manager: RuntimeManager
  store: StateStore
  uiRequests: ExtensionUiRequest[]
  statuses: ThreadStatusUpdate[]
  events: ThreadEventEnvelope[]
  responses: ExtensionUiResponse[]
  respondError: { value: Error | null }
  cleanup: () => void
}

function makeHarness(preset?: TrustPreset): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-policy-test-'))
  const store = new StateStore(join(dir, 'state.json'))
  store.mutate((draft) => {
    draft.projects.push({
      id: 'proj-1',
      name: 'demo',
      path: dir,
      addedAt: Date.now(),
      defaultHarness: 'pi',
      ...(preset ? { trustPreset: preset } : {}),
    })
    draft.threads.push({
      id: 'thread-1',
      projectId: 'proj-1',
      title: 't',
      harness: 'pi',
      cwd: dir,
      thinkingLevel: 'medium',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'streaming',
    })
  })
  const uiRequests: ExtensionUiRequest[] = []
  const statuses: ThreadStatusUpdate[] = []
  const events: ThreadEventEnvelope[] = []
  const responses: ExtensionUiResponse[] = []
  const respondError = { value: null as Error | null }
  const discovery = { snapshot: () => ({}), refresh: async () => ({}) } as unknown as HarnessDiscoveryService
  const manager = new RuntimeManager(store, discovery, {
    onThreadEvent: (e) => events.push(e),
    onThreadStatus: (s) => statuses.push(s),
    onExtensionUiRequest: (r) => uiRequests.push(r),
  })
  return {
    manager,
    store,
    uiRequests,
    statuses,
    events,
    responses,
    respondError,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function fakeRuntime(h: Harness): RpcRuntime {
  return {
    respondExtensionUi: async (resp: ExtensionUiResponse) => {
      if (h.respondError.value) throw h.respondError.value
      h.responses.push(resp)
    },
  } as unknown as RpcRuntime
}

function dispatch(h: Harness, req: Partial<ExtensionUiRequest> & { method: ExtensionUiRequest['method'] }) {
  const full: ExtensionUiRequest = {
    id: 'ui-1',
    threadId: 'thread-1',
    title: 'Claude 请求执行 Bash',
    ...req,
  }
  ;(h.manager as unknown as {
    handleExtensionUiRequest: (threadId: string, runtime: RpcRuntime, req: ExtensionUiRequest) => void
  }).handleExtensionUiRequest('thread-1', fakeRuntime(h), full)
}

const bashMessage = (command: string) => JSON.stringify({ command })

describe('RuntimeManager trust-policy interception', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  it('default preset (approval) forwards confirm to the user with waiting_ui', () => {
    h = makeHarness()
    dispatch(h, { method: 'confirm', message: bashMessage('npm run build') })
    expect(h.responses).toHaveLength(0)
    expect(h.uiRequests).toHaveLength(1)
    expect(h.uiRequests[0].policyPreset).toBe('approval')
    expect(h.statuses.some((s) => s.status === 'waiting_ui')).toBe(true)
  })

  it('readonly auto-denies write commands and emits a timeline notice', async () => {
    h = makeHarness('readonly')
    dispatch(h, { method: 'confirm', message: bashMessage('npm run build') })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.responses).toEqual([{ id: 'ui-1', confirmed: false }])
    expect(h.uiRequests).toHaveLength(0)
    expect(h.statuses.some((s) => s.status === 'waiting_ui')).toBe(false)
    const notice = h.events.find((e) => e.event.method === 'notify')
    expect(notice?.event.notifyType).toBe('warning')
    expect(String(notice?.event.message)).toContain('只读观察')
    const timeline = h.manager.getTimeline('thread-1')
    expect(timeline.some((item) => item.role === 'notice' && item.text.includes('只读观察'))).toBe(true)
  })

  it('readonly auto-allows read-only commands', async () => {
    h = makeHarness('readonly')
    dispatch(h, { method: 'confirm', message: bashMessage('git status') })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.responses).toEqual([{ id: 'ui-1', confirmed: true }])
    expect(h.uiRequests).toHaveLength(0)
  })

  it('auto allows normal writes without prompting', async () => {
    h = makeHarness('auto')
    dispatch(h, { method: 'confirm', message: bashMessage('npm run build') })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.responses).toEqual([{ id: 'ui-1', confirmed: true }])
    expect(h.uiRequests).toHaveLength(0)
  })

  it('auto still asks for high-risk commands and attaches the risk assessment', () => {
    h = makeHarness('auto')
    dispatch(h, { method: 'confirm', message: bashMessage('rm -rf /') })
    expect(h.responses).toHaveLength(0)
    expect(h.uiRequests).toHaveLength(1)
    expect(h.uiRequests[0].risk?.level).toBe('high')
    expect(h.uiRequests[0].risk?.reasons.length).toBeGreaterThan(0)
    expect(h.uiRequests[0].policyPreset).toBe('auto')
    expect(h.statuses.some((s) => s.status === 'waiting_ui')).toBe(true)
  })

  it('approval preset attaches risk info for high-risk commands', () => {
    h = makeHarness('approval')
    dispatch(h, { method: 'confirm', message: bashMessage('git push --force origin main') })
    expect(h.uiRequests).toHaveLength(1)
    expect(h.uiRequests[0].risk?.level).toBe('high')
  })

  it('select prompts: readonly picks the deny option', async () => {
    h = makeHarness('readonly')
    dispatch(h, {
      method: 'select',
      title: 'Codex 请求执行命令',
      message: 'npm install left-pad',
      options: ['Approve', 'Reject'],
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.responses).toEqual([{ id: 'ui-1', value: 'Reject' }])
  })

  it('select prompts: auto picks the allow option', async () => {
    h = makeHarness('auto')
    dispatch(h, {
      method: 'select',
      title: 'Codex 请求执行命令',
      message: 'npm run build',
      options: ['Allow once', 'Deny'],
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.responses).toEqual([{ id: 'ui-1', value: 'Allow once' }])
  })

  it('select menus without recognisable allow/deny options go to the user, never auto-answered', async () => {
    for (const preset of ['readonly', 'auto'] as const) {
      h = makeHarness(preset)
      dispatch(h, {
        method: 'select',
        title: '选择模板',
        options: ['好的', '行'],
      })
      await new Promise((r) => setTimeout(r, 0))
      expect(h.responses).toEqual([])
      expect(h.uiRequests).toHaveLength(1)
      h.cleanup()
    }
  })

  it('input/editor requests always reach the user, even under readonly', () => {
    h = makeHarness('readonly')
    dispatch(h, { method: 'input', title: '请输入分支名' })
    expect(h.responses).toHaveLength(0)
    expect(h.uiRequests).toHaveLength(1)
    expect(h.uiRequests[0].policyPreset).toBe('readonly')
    expect(h.statuses.some((s) => s.status === 'waiting_ui')).toBe(true)
  })

  it('falls back to asking the user when the auto-response fails', async () => {
    h = makeHarness('auto')
    h.respondError.value = new Error('process died')
    dispatch(h, { method: 'confirm', message: bashMessage('npm run build') })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.responses).toHaveLength(0)
    expect(h.uiRequests).toHaveLength(1)
    expect(h.statuses.some((s) => s.status === 'waiting_ui')).toBe(true)
  })

  it('threads without a project fall back to the approval preset', () => {
    h = makeHarness('auto')
    h.store.mutate((draft) => {
      draft.threads[0].projectId = 'missing-project'
    })
    dispatch(h, { method: 'confirm', message: bashMessage('npm run build') })
    expect(h.responses).toHaveLength(0)
    expect(h.uiRequests).toHaveLength(1)
    expect(h.uiRequests[0].policyPreset).toBe('approval')
  })
})

describe('StateStore trust & harness normalization', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentui-store-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('defaults trustPreset to approval and keeps valid presets across reloads', () => {
    const file = join(dir, 'state.json')
    const store = new StateStore(file)
    store.mutate((draft) => {
      draft.projects.push(
        { id: 'a', name: 'a', path: dir, addedAt: 1, defaultHarness: 'pi' },
        { id: 'b', name: 'b', path: dir, addedAt: 2, defaultHarness: 'pi', trustPreset: 'readonly' },
        { id: 'c', name: 'c', path: dir, addedAt: 3, defaultHarness: 'pi', trustPreset: 'bogus' as TrustPreset },
      )
      draft.activeHarness = 'claude'
    })
    const reloaded = new StateStore(file)
    const state = reloaded.snapshot()
    expect(state.projects.find((p) => p.id === 'a')?.trustPreset).toBe('approval')
    expect(state.projects.find((p) => p.id === 'b')?.trustPreset).toBe('readonly')
    expect(state.projects.find((p) => p.id === 'c')?.trustPreset).toBe('approval')
    expect(state.activeHarness).toBe('claude')
  })

  it('accepts every harness id and resets invalid ones to pi', () => {
    const file = join(dir, 'state.json')
    for (const id of ['omp', 'prime', 'claude', 'codex', 'acp', 'dsh'] as const) {
      const store = new StateStore(file)
      store.mutate((draft) => {
        draft.activeHarness = id
      })
      expect(new StateStore(file).snapshot().activeHarness).toBe(id)
    }
    const store = new StateStore(file)
    store.mutate((draft) => {
      ;(draft as { activeHarness: string }).activeHarness = 'not-a-harness'
    })
    expect(new StateStore(file).snapshot().activeHarness).toBe('pi')
  })
})