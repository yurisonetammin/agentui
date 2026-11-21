// Herdr 接入的单元测试：共享解析器/匹配器（真实 CLI 输出夹具）+ 服务层（注入假子进程）。
// 真实 CLI 集成用例以 AGENTUI_LIVE_HERDR=1 门控，未安装或未开启时自动跳过。

import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  matchWorkspaceForProject,
  normalizeHerdrSettings,
  parseHerdrEnvelope,
  parseHerdrSnapshot,
  parseHerdrStatusServerOutput,
  parseWorkspaceCreated,
  type HerdrSnapshotView,
} from '../src/shared/herdr'
import { HerdrService } from '../electron/main/herdr-service'
import type { HerdrFrameEvent, HerdrStreamClosedEvent } from '../src/shared/herdr'
import type { ExecutableSpawnInvocation } from '../electron/main/process-utils'
import type { HerdrSettings } from '../src/shared/herdr'

// ── 真实 CLI 输出夹具（herdr 0.9.5 实测） ─────────────────────────────────

const LIVE_SNAPSHOT_JSON = '{"id":"cli:api:snapshot","result":{"snapshot":{"agents":[{"name":"lead","pane_id":"w1:p2","status":"working"}],"focused_pane_id":"w1:p1","focused_tab_id":"w1:t1","focused_workspace_id":"w1","layouts":[],"panes":[{"agent_status":"unknown","cwd":"E:\\\\agentgongztai\\\\agentui","focused":true,"pane_id":"w1:p1","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":40},"tab_id":"w1:t1","terminal_id":"term_1","workspace_id":"w1"},{"agent_status":"working","cwd":"E:\\\\agentgongztai\\\\agentui","focused":false,"pane_id":"w1:p2","revision":1,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":40},"tab_id":"w1:t2","terminal_id":"term_2","workspace_id":"w1"}],"protocol":22,"tabs":[{"agent_status":"unknown","focused":true,"label":"1","number":1,"pane_count":1,"tab_id":"w1:t1","workspace_id":"w1"},{"agent_status":"working","focused":false,"label":"2","number":2,"pane_count":1,"tab_id":"w1:t2","workspace_id":"w1"}],"version":"0.9.5","workspaces":[{"active_tab_id":"w1:t1","agent_status":"working","focused":true,"label":"agentui-probe","number":1,"pane_count":2,"tab_count":2,"workspace_id":"w1"}]},"type":"session_snapshot"}}'

const LIVE_CREATE_JSON = '{"id":"cli:workspace:create","result":{"root_pane":{"agent_status":"unknown","cwd":"E:\\\\agentgongztai\\\\agentui\\\\","focused":true,"pane_id":"w1:p1","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":40},"tab_id":"w1:t1","terminal_id":"term_x","workspace_id":"w1"},"tab":{"agent_status":"unknown","focused":true,"label":"1","number":1,"pane_count":1,"tab_id":"w1:t1","workspace_id":"w1"},"type":"workspace_created","workspace":{"active_tab_id":"w1:t1","agent_status":"unknown","focused":true,"label":"agentui-probe","number":1,"pane_count":1,"tab_count":1,"workspace_id":"w1"}}}'

describe('parseHerdrEnvelope', () => {
  it('提取成功信封的 result', () => {
    const envelope = parseHerdrEnvelope(LIVE_CREATE_JSON)
    expect(envelope?.error).toBeNull()
    expect(envelope?.result).not.toBeNull()
    expect(envelope?.result?.type).toBe('workspace_created')
  })

  it('提取 error 信封（server_not_running）', () => {
    const raw = '{"id":"cli:api:snapshot","error":{"code":"server_not_running","message":"no herdr server is running"}}'
    const envelope = parseHerdrEnvelope(raw)
    expect(envelope?.error?.code).toBe('server_not_running')
    expect(envelope?.error?.message).toBe('no herdr server is running')
    expect(envelope?.result).toBeNull()
  })

  it('对非 JSON 输出返回 null', () => {
    expect(parseHerdrEnvelope('not json at all')).toBeNull()
    expect(parseHerdrEnvelope('')).toBeNull()
  })
})

describe('parseHerdrSnapshot', () => {
  it('解析真实 snapshot JSON 为视图', () => {
    const envelope = parseHerdrEnvelope(LIVE_SNAPSHOT_JSON)
    const snapshot = parseHerdrSnapshot(envelope?.result ?? null)
    expect(snapshot.version).toBe('0.9.5')
    expect(snapshot.focusedWorkspaceId).toBe('w1')
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.workspaces[0]).toMatchObject({
      workspaceId: 'w1',
      label: 'agentui-probe',
      agentStatus: 'working',
      paneCount: 2,
    })
    expect(snapshot.panes).toHaveLength(2)
    expect(snapshot.panes[0].cwd).toBe('E:\\agentgongztai\\agentui')
    expect(snapshot.agents[0]).toMatchObject({ name: 'lead', paneId: 'w1:p2', status: 'working' })
  })

  it('对空/畸形输入回退为空视图', () => {
    const empty = parseHerdrSnapshot(null)
    expect(empty.workspaces).toEqual([])
    const partial = parseHerdrSnapshot({ workspaces: [42, null, { workspace_id: 'w2' }] } as unknown as Record<string, unknown>)
    expect(partial.workspaces).toHaveLength(1)
    expect(partial.workspaces[0].workspaceId).toBe('w2')
    expect(partial.workspaces[0].agentStatus).toBe('unknown')
  })
})

describe('parseWorkspaceCreated', () => {
  it('从真实 create 响应提取三个 ID', () => {
    const envelope = parseHerdrEnvelope(LIVE_CREATE_JSON)
    const created = parseWorkspaceCreated(envelope?.result ?? null)
    expect(created).toEqual({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
  })

  it('缺少字段时返回 null', () => {
    expect(parseWorkspaceCreated({ workspace: { workspace_id: 'w1' } })).toBeNull()
    expect(parseWorkspaceCreated(null)).toBeNull()
  })
})

describe('parseHerdrStatusServerOutput', () => {
  it('识别运行中与未运行', () => {
    expect(parseHerdrStatusServerOutput('status: running\nversion: 0.9.5\nendpoint_compatible: yes')).toEqual({
      running: true, version: '0.9.5', error: null,
    })
    expect(parseHerdrStatusServerOutput('status: not running\nsocket: C:\\Users\\T\\herdr.sock')).toEqual({
      running: false, version: null, error: null,
    })
  })

  it('无法识别时把输出作为 error', () => {
    const status = parseHerdrStatusServerOutput('herdr: command not found')
    expect(status.running).toBe(false)
    expect(status.error).toContain('command not found')
  })
})

describe('matchWorkspaceForProject', () => {
  const snapshot: HerdrSnapshotView = parseHerdrSnapshot(parseHerdrEnvelope(LIVE_SNAPSHOT_JSON)?.result ?? null)

  it('按面板 cwd 精确匹配（大小写/反斜杠不敏感）', () => {
    const matched = matchWorkspaceForProject(snapshot, 'e:\\AgentGongZtai\\agentui\\', null)
    expect(matched?.workspaceId).toBe('w1')
  })

  it('手动关联优先且仍然存在时直接采用', () => {
    const fake = { workspaceId: 'other', label: 'x', cwd: '', savedAt: 1 }
    expect(matchWorkspaceForProject(snapshot, 'E:\\agentgongztai\\agentui', fake)?.workspaceId).toBe('w1')
  })

  it('关联的工作区已消失时回退到自动匹配', () => {
    const stale = { workspaceId: 'gone', label: 'x', cwd: '', savedAt: 1 }
    expect(matchWorkspaceForProject(snapshot, 'E:\\agentgongztai\\agentui', stale)?.workspaceId).toBe('w1')
  })

  it('无匹配返回 null', () => {
    expect(matchWorkspaceForProject(snapshot, 'D:\\other\\project', null)).toBeNull()
  })
})

describe('normalizeHerdrSettings', () => {
  it('回填默认值并丢弃畸形关联', () => {
    const settings = normalizeHerdrSettings({
      customPath: ' D:\\tools\\herdr.exe ',
      session: 'agentui',
      associations: { p1: { workspaceId: 'w1', label: 'ws', cwd: 'E:\\repo', savedAt: 5 }, p2: 42, p3: null },
    } as unknown as HerdrSettings)
    expect(settings.customPath).toBe('D:\\tools\\herdr.exe')
    expect(settings.session).toBe('agentui')
    expect(Object.keys(settings.associations)).toEqual(['p1'])
  })

  it('空输入回退默认', () => {
    expect(normalizeHerdrSettings(null)).toEqual({
      customPath: null, session: 'default', associations: {},
    })
  })
})

// ── 服务层：注入假子进程 ─────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  pid: number | undefined = undefined
  killed = false
  kill(): boolean {
    if (this.killed) return true
    this.killed = true
    this.exitCode = 0
    queueMicrotask(() => this.emit('close', 0, null))
    return true
  }
}

interface Recording {
  frames: HerdrFrameEvent[]
  closed: HerdrStreamClosedEvent[]
  connections: number[]
}

function makeService(liveFrames: Record<string, unknown>[] = []) {
  const settings: HerdrSettings = { customPath: null, session: 'default', associations: {} }
  const recording: Recording = { frames: [], closed: [], connections: [] }
  const children: FakeChild[] = []

  class TestService extends HerdrService {
    async getStatus() {
      return { available: true, path: 'C:\\fake\\herdr.exe', version: '0.9.5', error: null }
    }
    protected spawnStreamChild(_invocation: ExecutableSpawnInvocation) {
      const child = new FakeChild()
      children.push(child)
      queueMicrotask(() => {
        for (const frame of liveFrames) child.stdout.write(`${JSON.stringify(frame)}\n`)
      })
      return child as unknown as import('node:child_process').ChildProcess
    }
  }

  const service = new TestService({
    onFrame: (event) => recording.frames.push(event),
    onStreamClosed: (event) => recording.closed.push(event),
    onConnectionChanged: (id) => recording.connections.push(id),
  }, {
    getSettings: () => settings,
    setSettings: (next) => Object.assign(settings, next),
  })
  return { service, settings, recording, children }
}

const FRAME_1 = { type: 'terminal.frame', seq: 1, bytes: Buffer.from('\x1b[1;1Hhello', 'utf8').toString('base64'), encoding: 'ansi', full: true, width: 100, height: 30 }

describe('HerdrService 流管理', () => {
  it('observe 流把 terminal.frame 解码为帧事件，closed 后收尾', async () => {
    const { service, recording, children } = makeService([FRAME_1, { type: 'terminal.closed' }])
    const attached = await service.attachStream('w1:p1', { mode: 'observe', cols: 100, rows: 30 })
    expect(attached.mode).toBe('observe')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(recording.frames).toHaveLength(1)
    expect(recording.frames[0]).toMatchObject({ paneId: 'w1:p1', seq: 1, cols: 100, rows: 30, full: true })
    expect(Buffer.from(recording.frames[0].data, 'base64').toString('utf8')).toBe('\x1b[1;1Hhello')
    expect(recording.closed).toHaveLength(1)
    expect(recording.closed[0].reason).toBe('closed')
    expect(service.activeStreamCount()).toBe(0)
    expect(children[0].killed).toBe(true)
  })

  it('control 流把输入/resize 转发为 stdin NDJSON，release 写 terminal.release', async () => {
    const { service, children } = makeService([])
    const attached = await service.attachStream('w2:p1', { mode: 'control', cols: 110, rows: 32, takeover: true })
    expect(children).toHaveLength(1)
    const written: string[] = []
    children[0].stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))
    await service.streamInput(attached.streamId, 'echo hi\r')
    await service.streamResize(attached.streamId, 120, 40)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(written).toContainEqual(`{"type":"terminal.input","text":"echo hi\\r"}\n`)
    expect(written).toContainEqual(`{"type":"terminal.resize","cols":120,"rows":40}\n`)
    await service.releaseStream(attached.streamId)
    // 模拟 herdr CLI 收到 terminal.release 后自行退出（真实行为：exit code 0）。
    children[0].emit('close', 0, null)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(written.some((line) => line.includes('"type":"terminal.release"'))).toBe(true)
    expect(service.activeStreamCount()).toBe(0)
  })

  it('observe 流拒绝输入', async () => {
    const { service } = makeService([])
    const attached = await service.attachStream('w3:p1', { mode: 'observe', cols: 80, rows: 24 })
    await expect(service.streamInput(attached.streamId, 'x')).rejects.toThrow('只读观察流')
  })

  it('同一面板重复 attach 会替换旧流（replaced）', async () => {
    const { service, recording } = makeService([])
    const first = await service.attachStream('w4:p1', { mode: 'observe', cols: 80, rows: 24 })
    await service.attachStream('w4:p1', { mode: 'control', cols: 80, rows: 24 })
    expect(recording.closed.some((event) => event.streamId === first.streamId && event.reason === 'replaced')).toBe(true)
    expect(service.activeStreamCount()).toBe(1)
  })

  it('切换会话即撤销旧流输入，重名面板建立独立的新流', async () => {
    const { service, recording, children } = makeService([FRAME_1])
    const first = await service.attachStream('w1:p1', { mode: 'control', cols: 80, rows: 24, connectionId: 0 })
    try {
      const input: string[] = []
      children[0].stdin.on('data', (chunk: Buffer) => input.push(chunk.toString('utf8')))
      service.updateSettings({ session: 'default' })
      expect(recording.connections).toEqual([])
      service.updateSettings({ session: 'agentui' })
      expect(recording.connections).toEqual([1])
      expect(input.join('')).toContain('terminal.release')
      await expect(service.streamInput(first.streamId, 'x')).rejects.toThrow('连接已切换')
      await expect(service.getSnapshot(0)).rejects.toThrow('连接已切换')
      await expect(service.attachStream('w1:p1', { mode: 'observe', cols: 80, rows: 24, connectionId: 0 })).rejects.toThrow('连接已切换')
      children[0].stdout.write(`${JSON.stringify({ ...FRAME_1, seq: 2 })}\n`)
      const second = await service.attachStream('w1:p1', { mode: 'observe', cols: 80, rows: 24, connectionId: 1 })
      expect(second.streamId).not.toBe(first.streamId)
      expect(recording.frames.some((frame) => frame.streamId === first.streamId && frame.seq === 2)).toBe(false)
      expect(recording.frames.some((frame) => frame.streamId === second.streamId)).toBe(true)
    } finally {
      await service.stopStreams()
    }
  })

  it('等待 attach 回应时切换会话会作废旧请求', async () => {
    const { service, children } = makeService()
    const pending = service.attachStream('w1:p1', { mode: 'observe', cols: 80, rows: 24 })
    const rejected = expect(pending).rejects.toThrow('连接已切换')
    await Promise.resolve()
    expect(children).toHaveLength(1)
    service.updateSettings({ session: 'agentui' })
    await rejected
    await service.stopStreams()
  })

  it('流启动即退出时抛出 stderr 摘要', async () => {
    class FailingService extends HerdrService {
      async getStatus() {
        return { available: true, path: 'C:\\fake\\herdr.exe', version: '0.9.5', error: null }
      }
      protected spawnStreamChild(_invocation: ExecutableSpawnInvocation) {
        const child = new FakeChild()
        queueMicrotask(() => {
          child.stderr.write('error: another controller owns this terminal\n')
          child.emit('close', 1, null)
        })
        return child as unknown as import('node:child_process').ChildProcess
      }
    }
    const service = new FailingService({ onFrame: () => undefined, onStreamClosed: () => undefined }, {
      getSettings: () => ({ customPath: null, session: 'default', associations: {} }),
      setSettings: () => undefined,
    })
    await expect(service.attachStream('w5:p1', { mode: 'control', cols: 80, rows: 24 })).rejects.toThrow('another controller')
  })
})

describe('HerdrService 关联与设置', () => {
  it('setAssociation 持久化并可清除', () => {
    const { service, settings } = makeService()
    service.setAssociation('p1', { workspaceId: 'w1', label: 'ws', cwd: 'E:\\repo', savedAt: 1 })
    expect(settings.associations.p1?.workspaceId).toBe('w1')
    service.setAssociation('p1', null)
    expect(settings.associations.p1).toBeUndefined()
  })

  it('testPath 拒绝非绝对路径', async () => {
    const { service } = makeService()
    const status = await service.testPath('herdr')
    expect(status.available).toBe(false)
    expect(status.error).toContain('绝对路径')
  })

  it('testPath 对不存在的显式路径判不可用（不回退 PATH 误报成功）', async () => {
    const { service } = makeService()
    const missing = join(tmpdir(), 'agentui-no-such-herdr.exe')
    const status = await service.testPath(missing)
    expect(status.available).toBe(false)
    expect(status.path).toBe(missing)
    expect(status.error).toContain('不存在')
  })

  it('testPath 探测显式给出的真实可执行文件（node 自身）', async () => {
    const { service } = makeService()
    const status = await service.testPath(process.execPath)
    expect(status.available).toBe(true)
    expect(status.path).toBe(process.execPath)
    expect(status.version).toMatch(/^\d/)
  })

  it.each(['pi', 'prime'] as const)('launchAgent 为 %s 使用手动关联的工作区', async (kind) => {
    const { service, settings } = makeService()
    service.setAssociation('p1', { workspaceId: 'wA', label: 'assoc-ws', cwd: '', savedAt: 1 })
    void settings.associations
    const calls: string[][] = []
    ;(service as unknown as { runCli: unknown }).runCli = async (args: readonly string[]) => {
      calls.push([...args])
      // Herdr 0.9.5 的 pane run 成功时 stdout 为空。
      if (args[0] === 'pane') return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false }
      const payload = (() => {
        switch (args[0]) {
          case 'api':
            return { snapshot: { version: '0.9.5', workspaces: [{ workspace_id: 'wA', label: 'assoc-ws', number: 1, tab_count: 1, pane_count: 1, agent_status: 'unknown', focused: false, active_tab_id: 'wA:t1' }], tabs: [], panes: [{ pane_id: 'wA:p1', workspace_id: 'wA', tab_id: 'wA:t1', cwd: 'E:\\elsewhere', agent_status: 'unknown', focused: false }], agents: [], focused_workspace_id: null } }
          case 'tab':
            return { tab: { tab_id: 'wA:t2' }, root_pane: { pane_id: 'wA:p2' } }
          case 'agent':
            return { type: 'agent_started' }
          default:
            throw new Error(`unexpected command: ${args.join(' ')}`)
        }
      })()
      return { ok: true, code: 0, stdout: JSON.stringify({ result: payload }), stderr: '', timedOut: false }
    }
    const result = await service.launchAgent(kind, 'E:\\proj', 'proj', 'p1')
    expect(result.ok).toBe(true)
    expect(result.workspaceId).toBe('wA')
    expect(result.paneId).toBe('wA:p2')
    const tabCall = calls.find((c) => c[0] === 'tab')
    expect(tabCall?.[2]).toBe('--workspace')
    expect(tabCall?.[3]).toBe('wA')
    // 关联工作区被采用：没有触发 workspace create（cwd 与关联工作区目录并不一致）。
    expect(calls.some((c) => c[0] === 'workspace')).toBe(false)
    if (kind === 'prime') expect(calls).toContainEqual(['pane', 'run', 'wA:p2', 'prime-agent'])
  })

  it('launchAgent 无关联且目录不匹配时新建工作区', async () => {
    const { service } = makeService()
    const calls: string[][] = []
    ;(service as unknown as { runCli: unknown }).runCli = async (args: readonly string[]) => {
      calls.push([...args])
      const payload = (() => {
        switch (args[0]) {
          case 'api':
            return { snapshot: { version: '0.9.5', workspaces: [{ workspace_id: 'wA', label: 'other', number: 1, tab_count: 1, pane_count: 1, agent_status: 'unknown', focused: false, active_tab_id: 'wA:t1' }], tabs: [], panes: [{ pane_id: 'wA:p1', workspace_id: 'wA', tab_id: 'wA:t1', cwd: 'E:\\elsewhere', agent_status: 'unknown', focused: false }], agents: [], focused_workspace_id: null } }
          case 'workspace':
            return JSON.parse(LIVE_CREATE_JSON).result
          case 'tab':
            return { tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } }
          case 'agent':
            return { type: 'agent_started' }
          case 'pane':
            return { type: 'ok' }
          default:
            throw new Error(`unexpected command: ${args.join(' ')}`)
        }
      })()
      return { ok: true, code: 0, stdout: JSON.stringify({ result: payload }), stderr: '', timedOut: false }
    }
    const result = await service.launchAgent('omp', 'E:\\proj', 'proj', null)
    expect(result.ok).toBe(true)
    expect(result.workspaceId).toBe('w1')
    expect(calls.some((c) => c[0] === 'workspace')).toBe(true)
  })
})

// ── 真实 CLI 集成（AGENTUI_LIVE_HERDR=1 门控） ────────────────────────────

const liveHerdr = process.env.AGENTUI_LIVE_HERDR === '1'

describe.skipIf(!liveHerdr)('HerdrService 真实 CLI（AGENTUI_LIVE_HERDR=1）', () => {
  const service = new HerdrService({ onFrame: () => undefined, onStreamClosed: () => undefined }, {
    getSettings: () => ({ customPath: null, session: 'default', associations: {} }),
    setSettings: () => undefined,
  })

  it('检测本机 herdr', async () => {
    const status = await service.getStatus(true)
    expect(status.available).toBe(true)
    expect(status.version).toMatch(/^\d+\.\d+/)
  })

  it('读取服务状态与快照（服务运行时）', async () => {
    const server = await service.getServerStatus()
    if (!server.running) return
    const snapshot = await service.getSnapshot()
    expect(Array.isArray(snapshot.workspaces)).toBe(true)
    expect(Array.isArray(snapshot.panes)).toBe(true)
  }, 30_000)

  it('observe 流收到真实 terminal.frame 并可释放（服务运行时）', async () => {
    const server = await service.getServerStatus()
    if (!server.running) return
    const frames: HerdrFrameEvent[] = []
    const closed: HerdrStreamClosedEvent[] = []
    const live = new HerdrService({
      onFrame: (event) => frames.push(event),
      onStreamClosed: (event) => closed.push(event),
    }, {
      getSettings: () => ({ customPath: null, session: 'default', associations: {} }),
      setSettings: () => undefined,
    })
    const created = await service.createWorkspace(process.cwd(), 'agentui-live-test')
    try {
      const attached = await live.attachStream(created.paneId, { mode: 'observe', cols: 100, rows: 30 })
      const deadline = Date.now() + 8_000
      while (frames.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(frames.length).toBeGreaterThan(0)
      expect(frames[0].paneId).toBe(created.paneId)
      const decoded = Buffer.from(frames[0].data, 'base64').toString('latin1')
      expect(decoded).toContain('\x1b[')
      await live.releaseStream(attached.streamId)
      const closedDeadline = Date.now() + 5_000
      while (closed.length === 0 && Date.now() < closedDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(closed.length).toBeGreaterThan(0)
    } finally {
      await live.stopStreams()
      await service.closeWorkspace(created.workspaceId)
    }
  }, 40_000)
})
