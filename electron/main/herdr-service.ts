// Herdr 终端复用器接入服务（可选持久终端）。
// 全部经本机 `herdr` CLI（shell: false）与后台服务交互；流式观察/控制由
// `terminal session observe|control` 子进程的 NDJSON 流驱动，Herdr 服务与
// 终端进程完全由 Herdr 自己管理——AgentUI 退出只释放自己的流子进程。

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter, win32 as win32Path } from 'node:path'
import { homedir } from 'node:os'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import {
  isAbsoluteForPlatform,
  killProcessTree,
  prepareExecutableSpawn,
  runProcess,
  safeChildEnvironment,
  type ExecutableSpawnInvocation,
} from './process-utils'
import { StrictJsonlDecoder } from './rpc/jsonl'
import {
  HERDR_SESSION_AGENTUI,
  matchWorkspaceForProject,
  normalizeHerdrSettings,
  parseHerdrEnvelope,
  parseHerdrSnapshot,
  parseHerdrStatusServerOutput,
  parseWorkspaceCreated,
  type HerdrAssociation,
  type HerdrAttachOptions,
  type HerdrFrameEvent,
  type HerdrLaunchKind,
  type HerdrLaunchResult,
  type HerdrServerStatus,
  type HerdrSettings,
  type HerdrSnapshotView,
  type HerdrStatus,
  type HerdrStatusReport,
  type HerdrStreamClosedEvent,
  type HerdrStreamMode,
} from '@shared/herdr'

export type { HerdrFrameEvent, HerdrStreamClosedEvent, HerdrStatusReport }

export interface HerdrServiceCallbacks {
  onFrame: (event: HerdrFrameEvent) => void
  onStreamClosed: (event: HerdrStreamClosedEvent) => void
  onConnectionChanged?: (connectionId: number) => void
}

export interface HerdrServiceDeps {
  getSettings: () => HerdrSettings
  setSettings: (next: HerdrSettings) => void
}

interface HerdrCliResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export class HerdrNotRunningError extends Error {
  readonly code = 'server_not_running'
  constructor(message = 'Herdr 服务未运行') {
    super(message)
    this.name = 'HerdrNotRunningError'
  }
}

const STATUS_CACHE_MS = 60_000
const MAX_STREAMS = 8
const MAX_INPUT_BYTES = 64 * 1024
const STREAM_RELEASE_GRACE_MS = 1_500
const MAX_STREAM_FRAME_BYTES = 8 * 1024 * 1024

interface HerdrStream {
  streamId: string
  paneId: string
  connectionId: number
  mode: HerdrStreamMode
  child: ChildProcess
  decoder: StrictJsonlDecoder
  stderrTail: string[]
  finished: boolean
  errorExit: boolean
  releaseRequested: boolean
  releaseTimer: NodeJS.Timeout | null
}

export class HerdrService {
  private statusCache: { value: HerdrStatus; at: number; customPath: string | null } | null = null
  private readonly streams = new Map<string, HerdrStream>()
  private connectionId = 0

  constructor(
    private readonly callbacks: HerdrServiceCallbacks,
    private readonly deps: HerdrServiceDeps,
  ) {}

  settings(): HerdrSettings {
    return this.deps.getSettings()
  }

  updateSettings(patch: Partial<HerdrSettings>): HerdrSettings {
    const current = this.settings()
    const next = normalizeHerdrSettings({ ...current, ...patch })
    const connectionChanged = next.session !== current.session || next.customPath !== current.customPath
    this.deps.setSettings(next)
    if (connectionChanged) {
      this.connectionId += 1
      for (const id of this.streams.keys()) void this.releaseStream(id)
      this.callbacks.onConnectionChanged?.(this.connectionId)
    }
    return next
  }

  private assertConnection(connectionId: number): void {
    if (connectionId !== this.connectionId) throw new Error('Herdr 连接已切换，请重新选择面板')
  }

  setAssociation(projectId: string, association: HerdrAssociation | null): HerdrSettings {
    const current = this.settings()
    const associations = { ...current.associations }
    if (association) associations[projectId] = association
    else delete associations[projectId]
    const next = normalizeHerdrSettings({ ...current, associations })
    this.deps.setSettings(next)
    return next
  }

  // ── 可执行文件检测 ──

  private executableCandidates(customPath: string | null, platform = process.platform, home = homedir()): string[] {
    const candidates: string[] = []
    if (customPath && isAbsoluteForPlatform(customPath, platform)) candidates.push(customPath)
    const names = platform === 'win32' ? ['herdr.exe', 'herdr.cmd', 'herdr'] : ['herdr']
    const pathValue = platform === 'win32' ? (process.env.Path ?? process.env.PATH ?? '') : (process.env.PATH ?? '')
    const pathDirs = pathValue
      .split(platform === 'win32' ? ';' : delimiter)
      .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
      .filter((d) => isAbsoluteForPlatform(d, platform))
    const extraDirs = platform === 'win32'
      ? [win32Path.join(home, '.herdr', 'bin')]
      : [`${home}/.local/bin`, `${home}/.herdr/bin`]
    for (const dir of [...pathDirs, ...extraDirs]) {
      for (const name of names) candidates.push(win32Path.join(dir, name))
    }
    const unique: string[] = []
    const seenLower = new Set<string>()
    for (const candidate of candidates) {
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate
      if (seenLower.has(key)) continue
      seenLower.add(key)
      unique.push(candidate)
    }
    return unique
  }

  private findRunnable(candidates: readonly string[]): string | null {
    for (const candidate of candidates) {
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, fsConstants.F_OK)
        return candidate
      } catch {
        // keep trying
      }
    }
    return null
  }

  async getStatus(refresh = false): Promise<HerdrStatus> {
    const customPath = this.settings().customPath
    const cached = this.statusCache
    if (!refresh && cached && Date.now() - cached.at < STATUS_CACHE_MS && cached.customPath === customPath) {
      return cached.value
    }
    const value = await this.probeStatus(customPath)
    this.statusCache = { value, at: Date.now(), customPath }
    return value
  }

  /** CLI 检测 + 服务运行状态 + 会话模式，一次返回（设置页与面板共用）。 */
  async getStatusReport(refresh = false): Promise<HerdrStatusReport> {
    const connectionId = this.connectionId
    const session = this.settings().session
    const [status, server] = await Promise.all([this.getStatus(refresh), this.getServerStatus()])
    this.assertConnection(connectionId)
    return { status, server, session, connectionId }
  }

  /** 设置页「测试路径」：只探测显式给出的路径——文件不存在时直接判不可用，绝不回退 PATH。 */
  async testPath(path: string): Promise<HerdrStatus> {
    const trimmed = String(path ?? '').trim()
    if (!isAbsoluteForPlatform(trimmed, process.platform)) {
      return { available: false, path: trimmed || null, version: null, error: '请填写 herdr 可执行文件的绝对路径' }
    }
    try {
      if (!statSync(trimmed).isFile()) {
        return { available: false, path: trimmed, version: null, error: '路径不存在或不是文件' }
      }
      accessSync(trimmed, fsConstants.F_OK)
    } catch {
      return { available: false, path: trimmed, version: null, error: '路径不存在或不可访问' }
    }
    return this.probeVersionAt(trimmed)
  }

  private async probeStatus(customPath: string | null): Promise<HerdrStatus> {
    const executable = this.findRunnable(this.executableCandidates(customPath))
    if (!executable) {
      return { available: false, path: null, version: null, error: '未在本机找到 herdr 可执行文件，可在下方手动指定路径。' }
    }
    return this.probeVersionAt(executable)
  }

  private async probeVersionAt(executable: string): Promise<HerdrStatus> {
    try {
      const result = await runProcess(executable, ['--version'], { timeoutMs: 10_000, maxBytes: 64 * 1024 })
      if (result.timedOut) return { available: false, path: executable, version: null, error: 'herdr --version 超时' }
      const output = `${result.stdout}\n${result.stderr}`
      const match = /(\d+(?:\.\d+)+)/.exec(output)
      if (result.code === 0 && match) {
        return { available: true, path: executable, version: match[1], error: null }
      }
      return {
        available: false,
        path: executable,
        version: null,
        error: (result.stderr || result.stdout || 'herdr --version 执行失败').trim().slice(0, 240),
      }
    } catch (error) {
      return { available: false, path: executable, version: null, error: String((error as Error)?.message ?? error).slice(0, 240) }
    }
  }

  // ── CLI 封装 ──

  private cliEnvironment(): NodeJS.ProcessEnv {
    const env = safeChildEnvironment()
    // AgentUI 自身可能运行在 Herdr pane 内（继承 HERDR_SOCKET_PATH / HERDR_SESSION），
    // CLI 端点与会话选择必须只由本服务设置决定，不能沿用继承值。
    delete env.HERDR_SOCKET_PATH
    delete env.HERDR_SESSION
    if (this.settings().session === 'agentui') {
      env.HERDR_SESSION = HERDR_SESSION_AGENTUI
    }
    return env
  }

  private async runCli(args: readonly string[], options: { timeoutMs?: number; maxBytes?: number; connectionId?: number } = {}): Promise<HerdrCliResult> {
    const connectionId = options.connectionId ?? this.connectionId
    this.assertConnection(connectionId)
    const status = await this.getStatus()
    this.assertConnection(connectionId)
    if (!status.available || !status.path) {
      throw new Error(status.error ?? 'herdr CLI 未就绪，无法执行 ' + args[0])
    }
    const env = this.cliEnvironment()
    const invocation = prepareExecutableSpawn(status.path, [...args], env)
    const result = await runProcess(invocation.file, invocation.args, {
      env: invocation.env,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
      resolveHarnessShim: false,
    })
    this.assertConnection(connectionId)
    return {
      ok: !result.timedOut && result.code === 0,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    }
  }

  /** 把 CLI 失败转成带 error.code 语义的异常；server_not_running 用类型标记便于 UI 提示启动。 */
  private assertCliSuccess(result: HerdrCliResult, fallbackLabel: string): ReturnType<typeof parseHerdrEnvelope> {
    const envelope = parseHerdrEnvelope(`${result.stdout}\n${result.stderr}`)
    if (!result.ok || envelope?.error) {
      const message = envelope?.error?.message
        ?? (result.timedOut ? `${fallbackLabel} 超时` : (result.stderr || result.stdout || `${fallbackLabel} 执行失败`).trim().slice(0, 300))
      if (envelope?.error?.code === 'server_not_running') throw new HerdrNotRunningError(message)
      throw new Error(`${fallbackLabel}失败：${message}`)
    }
    return envelope
  }

  private assertCli(result: HerdrCliResult, fallbackLabel: string): { result: HerdrCliResult; envelope: NonNullable<ReturnType<typeof parseHerdrEnvelope>> } {
    const envelope = this.assertCliSuccess(result, fallbackLabel)
    if (!envelope) throw new Error(`${fallbackLabel}失败：无法解析 herdr JSON 输出`)
    return { result, envelope }
  }

  // ── 服务生命周期 ──

  async getServerStatus(): Promise<HerdrServerStatus> {
    const status = await this.getStatus()
    if (!status.available || !status.path) {
      return { running: false, version: null, error: status.error }
    }
    const result = await runProcess(status.path, ['status', 'server'], {
      env: this.cliEnvironment(),
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
      resolveHarnessShim: false,
    })
    return parseHerdrStatusServerOutput(`${result.stdout}\n${result.stderr}`)
  }

  /** 后台拉起 Herdr 服务（detached，不随 AgentUI 退出），并轮询直到就绪。 */
  async startServer(): Promise<HerdrServerStatus> {
    const status = await this.getStatus()
    if (!status.available || !status.path) throw new Error(status.error ?? 'herdr CLI 未就绪')
    const current = await this.getServerStatus()
    if (current.running) return current
    const env = this.cliEnvironment()
    const invocation = prepareExecutableSpawn(status.path, ['server'], env)
    try {
      const child = spawn(invocation.file, invocation.args, {
        env: invocation.env,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } catch (error) {
      throw new Error(`启动 Herdr 服务失败：${String((error as Error)?.message ?? error)}`)
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const probe = await this.getServerStatus()
      if (probe.running) return probe
    }
    throw new Error('Herdr 服务启动超时（10s 内未就绪）')
  }

  // ── 快照 / 工作区 / 面板 ──

  async getSnapshot(connectionId = this.connectionId): Promise<HerdrSnapshotView> {
    const result = await this.runCli(['api', 'snapshot'], { timeoutMs: 15_000, connectionId })
    const { envelope } = this.assertCli(result, '读取 Herdr 快照')
    return parseHerdrSnapshot(envelope.result)
  }

  async createWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; tabId: string; paneId: string; label: string }> {
    const result = await this.runCli(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'], { timeoutMs: 20_000 })
    const { envelope } = this.assertCli(result, '创建 Herdr 工作区')
    const created = parseWorkspaceCreated(envelope.result)
    if (!created) throw new Error('创建 Herdr 工作区失败：响应缺少 workspace/tab/pane 标识')
    return { ...created, label }
  }

  async readPane(
    paneId: string,
    options: { source?: 'visible' | 'recent' | 'recent-unwrapped'; lines?: number } = {},
  ): Promise<string> {
    const args = ['pane', 'read', paneId, '--source', options.source ?? 'visible']
    if (options.lines && options.lines > 0) args.push('--lines', String(Math.floor(options.lines)))
    const result = await this.runCli(args, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 })
    const envelope = parseHerdrEnvelope(`${result.stdout}\n${result.stderr}`)
    if (!result.ok || envelope?.error) {
      const message = envelope?.error?.message ?? (result.stderr || result.stdout || '读取失败').trim().slice(0, 300)
      if (envelope?.error?.code === 'server_not_running') throw new HerdrNotRunningError(message)
      throw new Error(`读取 Herdr 面板失败：${message}`)
    }
    return result.stdout.replace(/\r$/g, '').replace(/\n$/, '')
  }

  /** 在 Herdr TUI 中定位面板：聚焦其所在标签页（`pane focus` 仅支持方向移动，不能按 ID 定位）。 */
  async focusTab(tabId: string): Promise<void> {
    const result = await this.runCli(['tab', 'focus', tabId], { timeoutMs: 15_000 })
    this.assertCli(result, '聚焦 Herdr 标签页')
  }

  /** 关闭 Herdr 工作区（关闭其全部标签与面板进程）。 */
  async closeWorkspace(workspaceId: string): Promise<void> {
    const result = await this.runCli(['workspace', 'close', workspaceId], { timeoutMs: 15_000 })
    this.assertCli(result, '关闭 Herdr 工作区')
  }

  // ── 在 Herdr 中新建引擎会话 ──

  /**
   * 在关联（或按 cwd 匹配/新建）的工作区里新开一个标签页，并启动引擎：
   * Pi / OMP 经 `agent start`（可获 Herdr 状态徽标），Prime 以普通命令运行。
   * 手动关联的工作区优先于自动匹配（避免「新建会话」绕过用户选择）。
   */
  async launchAgent(kind: HerdrLaunchKind, cwd: string, workspaceLabel: string, projectId?: string | null): Promise<HerdrLaunchResult> {
    const connectionId = this.connectionId
    let snapshot: HerdrSnapshotView
    try {
      snapshot = await this.getSnapshot(connectionId)
    } catch (error) {
      return { ok: false, workspaceId: null, paneId: null, agentName: null, error: String((error as Error)?.message ?? error) }
    }
    const association = projectId ? this.settings().associations[projectId] ?? null : null
    const matched = matchWorkspaceForProject(snapshot, cwd, association)
    let workspaceId: string | null = null
    try {
      this.assertConnection(connectionId)
      workspaceId = matched ? matched.workspaceId : (await this.createWorkspace(cwd, workspaceLabel)).workspaceId

      const tabResult = await this.runCli(
        ['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', kind, '--no-focus'],
        { timeoutMs: 20_000, connectionId },
      )
      const { envelope } = this.assertCli(tabResult, '创建 Herdr 标签页')
      const tab = (envelope.result?.tab ?? null) as Record<string, unknown> | null
      const pane = (envelope.result?.root_pane ?? null) as Record<string, unknown> | null
      const paneId = typeof pane?.pane_id === 'string' ? pane.pane_id : null
      if (!paneId) throw new Error('响应缺少 root_pane.pane_id')
      void tab

      let agentName: string | null = null
      if (kind === 'prime') {
        const runResult = await this.runCli(['pane', 'run', paneId, 'prime-agent'], { timeoutMs: 20_000, connectionId })
        // pane run 成功时可以没有 stdout。
        this.assertCliSuccess(runResult, '启动 prime-agent')
      } else {
        agentName = `agentui-${randomUUID().slice(0, 8)}`
        let started = false
        let lastError = ''
        for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000))
          try {
            const startResult = await this.runCli(
              ['agent', 'start', agentName, '--kind', kind, '--pane', paneId, '--timeout', '20000'],
              { timeoutMs: 30_000, connectionId },
            )
            this.assertCli(startResult, '启动 Herdr agent')
            started = true
          } catch (error) {
            this.assertConnection(connectionId)
            lastError = String((error as Error)?.message ?? error)
          }
        }
        if (!started) throw new Error(lastError || '启动 Herdr agent 失败')
      }
      return { ok: true, workspaceId, paneId, agentName, error: null }
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      return {
        ok: false,
        workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
        paneId: null,
        agentName: null,
        error: message,
      }
    }
  }

  // ── 流式观察 / 控制 ──

  /**
   * 打开一条终端流：observe 只读、control 可写（一个终端同时只允许一个控制端）。
   * 同一面板已有流时先释放旧流（reason 'replaced'）。
   */
  async attachStream(
    paneId: string,
    options: HerdrAttachOptions,
  ): Promise<{ streamId: string; mode: HerdrStreamMode }> {
    const connectionId = options.connectionId ?? this.connectionId
    this.assertConnection(connectionId)
    const status = await this.getStatus()
    this.assertConnection(connectionId)
    if (!status.available || !status.path) throw new Error(status.error ?? 'herdr CLI 未就绪')
    const paneIdTrim = paneId.trim()
    if (!paneIdTrim) throw new Error('缺少 Herdr 面板 ID')
    const cols = Math.max(2, Math.min(500, Math.floor(options.cols || 120)))
    const rows = Math.max(2, Math.min(300, Math.floor(options.rows || 40)))

    for (const [existingId, existing] of [...this.streams.entries()]) {
      if (existing.connectionId === connectionId && existing.paneId === paneIdTrim) {
        await this.releaseStream(existingId, 'replaced')
      }
    }
    this.assertConnection(connectionId)
    if (this.streams.size >= MAX_STREAMS) {
      throw new Error(`Herdr 流数量已达上限（${MAX_STREAMS}），请先关闭部分预览。`)
    }

    const args = ['terminal', 'session', options.mode, paneIdTrim, '--cols', String(cols), '--rows', String(rows)]
    if (options.mode === 'control' && options.takeover) args.push('--takeover')
    const env = this.cliEnvironment()
    const invocation = prepareExecutableSpawn(status.path, args, env)

    let child: ChildProcess
    try {
      child = this.spawnStreamChild(invocation)
    } catch (error) {
      throw new Error(`启动 herdr ${options.mode} 流失败：${String((error as Error)?.message ?? error)}`)
    }

    const streamId = randomUUID()
    const stream: HerdrStream = {
      streamId,
      paneId: paneIdTrim,
      connectionId,
      mode: options.mode,
      child,
      decoder: new StrictJsonlDecoder((line) => this.handleStreamLine(stream, line), MAX_STREAM_FRAME_BYTES),
      stderrTail: [],
      finished: false,
      errorExit: false,
      releaseRequested: false,
      releaseTimer: null,
    }
    this.streams.set(streamId, stream)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      try {
        stream.decoder.push(chunk)
      } catch (error) {
        this.finishStream(stream, 'error', String((error as Error)?.message ?? error))
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stream.stderrTail.push(chunk)
      if (stream.stderrTail.length > 20) stream.stderrTail.shift()
    })
    child.on('error', (error) => {
      this.finishStream(stream, 'error', String(error?.message ?? error))
    })
    child.on('close', (code, signal) => {
      if (stream.finished) return
      if (stream.releaseRequested || code === 0) {
        this.finishStream(stream, stream.releaseRequested ? 'released' : 'closed', null)
        return
      }
      const tail = stream.stderrTail.join('').trim().slice(0, 300)
      const message = tail || `herdr ${stream.mode} 流退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`
      this.finishStream(stream, 'error', message)
    })

    // 尽早暴露“已有控制端”等启动错误：流若立即退出，close 回调已能通知 UI。
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(resolve, 300)
      timer.unref()
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.assertConnection(connectionId)
    if (stream.finished && stream.errorExit) {
      const message = stream.stderrTail.join('').trim().slice(0, 300) || `herdr ${options.mode} 流启动即退出`
      throw new Error(message)
    }
    return { streamId, mode: options.mode }
  }

  /** 流子进程 spawn 点：测试可注入假子进程（观察/控制流均为长驻进程，不走 runProcess）。 */
  protected spawnStreamChild(invocation: ExecutableSpawnInvocation): ChildProcess {
    return spawn(invocation.file, invocation.args, {
      env: invocation.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  private handleStreamLine(stream: HerdrStream, line: string): void {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (record.type === 'terminal.frame' && typeof record.bytes === 'string' && stream.connectionId === this.connectionId) {
      this.callbacks.onFrame({
        streamId: stream.streamId,
        paneId: stream.paneId,
        data: record.bytes,
        seq: typeof record.seq === 'number' ? record.seq : 0,
        cols: typeof record.width === 'number' ? record.width : 0,
        rows: typeof record.height === 'number' ? record.height : 0,
        full: record.full === true,
      })
      return
    }
    if (record.type === 'terminal.closed') {
      this.finishStream(stream, stream.releaseRequested ? 'released' : 'closed', null)
    }
  }

  private writeStreamCommand(stream: HerdrStream, command: Record<string, unknown>): void {
    if (stream.finished || !stream.child.stdin || stream.child.stdin.destroyed) {
      throw new Error('Herdr 流已关闭')
    }
    stream.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  async streamInput(streamId: string, text: string): Promise<void> {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error('Herdr 流不存在或已关闭')
    this.assertConnection(stream.connectionId)
    if (stream.mode !== 'control') throw new Error('当前为只读观察流，接管输入后才能发送键盘')
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('单次输入过大（上限 64KB）')
    this.writeStreamCommand(stream, { type: 'terminal.input', text })
  }

  async streamResize(streamId: string, cols: number, rows: number): Promise<void> {
    const stream = this.streams.get(streamId)
    if (!stream) throw new Error('Herdr 流不存在或已关闭')
    this.assertConnection(stream.connectionId)
    if (stream.mode !== 'control') return // 观察流无 resize 权限，静默忽略
    const safeCols = Math.max(2, Math.min(500, Math.floor(cols)))
    const safeRows = Math.max(2, Math.min(300, Math.floor(rows)))
    this.writeStreamCommand(stream, { type: 'terminal.resize', cols: safeCols, rows: safeRows })
  }

  /** 释放控制权并关闭流子进程；terminal 进程继续由 Herdr 管理。 */
  async releaseStream(streamId: string, reason: HerdrStreamClosedEvent['reason'] = 'released'): Promise<void> {
    const stream = this.streams.get(streamId)
    if (!stream || (stream.releaseRequested && reason === 'released')) return
    if (stream.releaseTimer) clearTimeout(stream.releaseTimer)
    stream.releaseRequested = reason === 'released'
    // 被同面板新流取代时立即终止旧子进程（observe 无 stdin 协议，control 尽力补发 release）。
    if (reason === 'replaced') {
      if (stream.mode === 'control' && !stream.finished && stream.child.stdin && !stream.child.stdin.destroyed) {
        try {
          this.writeStreamCommand(stream, { type: 'terminal.release' })
        } catch {
          // stdin 已不可写，直接杀子进程
        }
      }
      await this.killStream(stream, 'replaced')
      return
    }
    if (stream.mode === 'control' && !stream.finished && stream.child.stdin && !stream.child.stdin.destroyed) {
      try {
        this.writeStreamCommand(stream, { type: 'terminal.release' })
      } catch {
        // stdin 已不可写，直接杀子进程
      }
    }
    stream.releaseTimer = setTimeout(() => {
      void this.killStream(stream, reason)
    }, STREAM_RELEASE_GRACE_MS)
    stream.releaseTimer.unref()
  }

  private async killStream(stream: HerdrStream, reason: HerdrStreamClosedEvent['reason']): Promise<void> {
    if (stream.finished) return
    const pid = stream.child.pid
    if (pid) await killProcessTree(pid).catch(() => undefined)
    else try { stream.child.kill('SIGKILL') } catch { /* ignore */ }
    this.finishStream(stream, reason, null)
  }

  private finishStream(stream: HerdrStream, reason: HerdrStreamClosedEvent['reason'], message: string | null): void {
    if (stream.finished) return
    stream.finished = true
    stream.errorExit = reason === 'error'
    if (stream.releaseTimer) {
      clearTimeout(stream.releaseTimer)
      stream.releaseTimer = null
    }
    this.streams.delete(stream.streamId)
    try { stream.child.kill('SIGKILL') } catch { /* already dead */ }
    this.callbacks.onStreamClosed({ streamId: stream.streamId, paneId: stream.paneId, reason, message })
  }

  /** 应用退出时释放所有流子进程；Herdr 服务与终端进程不受影响。 */
  async stopStreams(): Promise<void> {
    const ids = [...this.streams.keys()]
    await Promise.allSettled(ids.map((id) => this.releaseStream(id, 'released')))
    for (const [, stream] of [...this.streams.entries()]) {
      await this.killStream(stream, 'released')
    }
  }

  activeStreamCount(): number {
    return this.streams.size
  }
}
