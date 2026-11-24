import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isValidCronExpression,
  matchesCronDate,
  nextCronRun,
  normalizeScheduledTask,
  parseCronExpression,
  parsePrimeScheduleListOutput,
  parsePrimeStatusOutput,
  type PrimeHeartbeatStatus,
  type ScheduledTask,
  type ScheduleRunRecord,
  type ScheduleSnapshot,
  type UpsertScheduledTaskInput,
} from '@shared/scheduler'
import { isTrustPreset, type ToolPermissionRule, type TrustPreset } from '@shared/tool-policy'
import { HARNESS_IDS, type HarnessId } from '@shared/types'
import type { HarnessDiscoveryService } from './discovery'
import { harnessChildEnvironment, runProcess } from './process-utils'
import type { StateStore } from './store'

const MAX_RUN_HISTORY = 60
const TICK_INTERVAL_MS = 20_000

interface PersistedScheduleFile {
  tasks: ScheduledTask[]
  runs: ScheduleRunRecord[]
}

export type ScheduledTaskRunner = (input: {
  cwd: string
  harness: HarnessId
  modelProvider?: string | null
  modelId?: string | null
  trustPreset: TrustPreset
  projectRules?: readonly ToolPermissionRule[]
  prompt: string
}) => Promise<{ summary: string }>

export class ScheduleService {
  private readonly filePath: string
  private tasks: ScheduledTask[] = []
  private runs: ScheduleRunRecord[] = []
  private readonly runningTaskIds = new Set<string>()
  private readonly lastTriggeredMinute = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly deps: {
      store: StateStore
      discovery: HarnessDiscoveryService
      runTask: ScheduledTaskRunner
      onUpdate?: (snapshot: ScheduleSnapshot) => void
      onFailureNotify?: (task: ScheduledTask, error: string) => void
      filePath?: string
    },
  ) {
    this.filePath = deps.filePath ?? join(dirname(deps.store.path), 'schedules.json')
    this.loadFromDisk()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_INTERVAL_MS)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedScheduleFile>
      this.tasks = Array.isArray(raw.tasks)
        ? raw.tasks.map(normalizeScheduledTask).filter((t): t is ScheduledTask => t !== null)
        : []
      this.runs = Array.isArray(raw.runs)
        ? raw.runs
            .filter((r): r is ScheduleRunRecord => Boolean(r && typeof r === 'object' && typeof r.id === 'string' && typeof r.taskId === 'string'))
            .slice(0, MAX_RUN_HISTORY)
        : []
    } catch {
      this.tasks = []
      this.runs = []
    }
  }

  private saveToDisk(): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    const payload: PersistedScheduleFile = {
      tasks: this.tasks,
      runs: this.runs.slice(0, MAX_RUN_HISTORY),
    }
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  private notifyUpdate(): void {
    this.deps.onUpdate?.(this.snapshot())
  }

  snapshot(): ScheduleSnapshot {
    const now = Date.now()
    const nextRuns: Record<string, number | null> = {}
    for (const task of this.tasks) {
      nextRuns[task.id] = task.enabled ? nextCronRun(task.cron, now) : null
    }
    return {
      tasks: structuredClone(this.tasks),
      runs: structuredClone(this.runs),
      runningTaskIds: [...this.runningTaskIds],
      nextRuns,
    }
  }

  upsertTask(input: UpsertScheduledTaskInput): ScheduleSnapshot {
    const name = String(input.name ?? '').trim().slice(0, 100)
    if (!name) throw new Error('任务名称不能为空')
    const cron = String(input.cron ?? '').trim()
    if (!isValidCronExpression(cron)) {
      throw new Error('无效的 Cron 表达式（需要 5 段格式如 "0 9 * * *" 或 @hourly/@daily/@weekly）')
    }
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) throw new Error('执行指令不能为空')
    if (!HARNESS_IDS.includes(input.harness)) throw new Error('无效的引擎类型')

    const project = this.deps.store.snapshot().projects.find((p) => p.id === input.projectId)
    if (!project) throw new Error('所选项目不存在')

    const trustPreset: TrustPreset = isTrustPreset(input.trustPreset) ? input.trustPreset : 'readonly'
    const now = Date.now()
    const existingIdx = input.id ? this.tasks.findIndex((t) => t.id === input.id) : -1

    if (existingIdx >= 0) {
      const prev = this.tasks[existingIdx]!
      this.tasks[existingIdx] = {
        ...prev,
        name,
        cron,
        projectId: project.id,
        harness: input.harness,
        modelProvider: input.modelProvider?.trim() || null,
        modelId: input.modelId?.trim() || null,
        trustPreset,
        prompt,
        enabled: input.enabled ?? prev.enabled,
        notifyOnFailure: input.notifyOnFailure ?? prev.notifyOnFailure,
        updatedAt: now,
      }
    } else {
      this.tasks.unshift({
        id: `task-${randomUUID().slice(0, 10)}`,
        name,
        cron,
        projectId: project.id,
        harness: input.harness,
        modelProvider: input.modelProvider?.trim() || null,
        modelId: input.modelId?.trim() || null,
        trustPreset,
        prompt,
        enabled: input.enabled ?? true,
        notifyOnFailure: input.notifyOnFailure ?? true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastStatus: null,
        lastSummary: null,
        lastError: null,
      })
    }

    this.saveToDisk()
    this.notifyUpdate()
    return this.snapshot()
  }

  toggleTask(taskId: string, enabled: boolean): ScheduleSnapshot {
    const target = this.tasks.find((t) => t.id === taskId)
    if (!target) throw new Error('定时任务不存在')
    target.enabled = Boolean(enabled)
    target.updatedAt = Date.now()
    this.saveToDisk()
    this.notifyUpdate()
    return this.snapshot()
  }

  deleteTask(taskId: string): ScheduleSnapshot {
    this.tasks = this.tasks.filter((t) => t.id !== taskId)
    this.lastTriggeredMinute.delete(taskId)
    this.saveToDisk()
    this.notifyUpdate()
    return this.snapshot()
  }

  async tick(nowDate = new Date()): Promise<void> {
    const minuteSlot = Math.floor(nowDate.getTime() / 60_000)
    const due: ScheduledTask[] = []
    for (const task of this.tasks) {
      if (!task.enabled || this.runningTaskIds.has(task.id)) continue
      if (this.lastTriggeredMinute.get(task.id) === minuteSlot) continue
      const parsed = parseCronExpression(task.cron)
      if (!parsed || !matchesCronDate(parsed, nowDate)) continue
      this.lastTriggeredMinute.set(task.id, minuteSlot)
      due.push(task)
    }
    if (due.length === 0) return
    await Promise.allSettled(due.map((task) => this.executeTask(task.id, 'cron')))
  }

  async runTaskNow(taskId: string): Promise<ScheduleRunRecord> {
    return this.executeTask(taskId, 'manual')
  }

  private async executeTask(taskId: string, trigger: 'cron' | 'manual'): Promise<ScheduleRunRecord> {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error('定时任务不存在')
    if (this.runningTaskIds.has(task.id)) {
      throw new Error('该定时任务正在运行中，请稍候')
    }

    this.runningTaskIds.add(task.id)
    this.notifyUpdate()

    const startedAt = Date.now()
    let status: 'success' | 'error' = 'success'
    let summary: string | null = null
    let error: string | null = null

    try {
      const project = this.deps.store.snapshot().projects.find((p) => p.id === task.projectId)
      if (!project || !existsSync(project.path) || !statSync(project.path).isDirectory()) {
        throw new Error('绑定的项目目录不存在或已被移除')
      }
      const res = await this.deps.runTask({
        cwd: project.path,
        harness: task.harness,
        modelProvider: task.modelProvider,
        modelId: task.modelId,
        trustPreset: task.trustPreset,
        projectRules: project.permissionRules,
        prompt: task.prompt,
      })
      summary = res.summary
    } catch (err) {
      status = 'error'
      error = err instanceof Error ? err.message : String(err)
    } finally {
      this.runningTaskIds.delete(task.id)
    }

    const finishedAt = Date.now()
    const record: ScheduleRunRecord = {
      id: `run-${randomUUID().slice(0, 10)}`,
      taskId: task.id,
      taskName: task.name,
      projectId: task.projectId,
      harness: task.harness,
      trigger,
      startedAt,
      finishedAt,
      status,
      summary,
      error,
    }

    const liveTask = this.tasks.find((t) => t.id === task.id)
    if (liveTask) {
      liveTask.lastRunAt = finishedAt
      liveTask.lastStatus = status
      liveTask.lastSummary = summary
      liveTask.lastError = error
    }
    this.runs = [record, ...this.runs].slice(0, MAX_RUN_HISTORY)
    this.saveToDisk()
    this.notifyUpdate()

    if (status === 'error' && task.notifyOnFailure && error) {
      this.deps.onFailureNotify?.(task, error)
    }

    return record
  }

  /**
   * Inspect Prime Agent's native background daemon & schedule list (`prime-agent status --json`
   * and `prime-agent schedule list --all --json`), strictly read-only & shell:false.
   */
  async getPrimeHeartbeatStatus(): Promise<PrimeHeartbeatStatus> {
    const prime = this.deps.discovery.snapshot().prime
    const checkedAt = Date.now()
    if (!prime?.ready || !prime.path) {
      return {
        installed: false,
        version: prime?.version ?? null,
        daemons: [],
        daemonRunning: false,
        nativeSchedules: [],
        checkedAt,
        note: '未检测到 Prime Agent CLI，暂无法查询原生后台心跳与计划任务。',
      }
    }

    const env = harnessChildEnvironment('prime', prime.agentDir, { PRIME_AGENT_TELEMETRY: '0' })
    const statusRes = await runProcess(prime.path, ['status', '--json'], {
      env,
      timeoutMs: 6_000,
    }).catch(() => null)

    if (!statusRes || statusRes.code !== 0) {
      return {
        installed: true,
        version: prime.version,
        daemons: [],
        daemonRunning: false,
        nativeSchedules: [],
        checkedAt,
        note: '当前 Prime Agent 版本暂不支持 status --json 查询。',
      }
    }

    const daemons = parsePrimeStatusOutput(statusRes.stdout)
    const daemonRunning = daemons.some((d) => d.status.toLowerCase() === 'running' || d.status.toLowerCase() === 'ready')
    if (!daemonRunning) {
      return {
        installed: true,
        version: prime.version,
        daemons,
        daemonRunning: false,
        nativeSchedules: [],
        checkedAt,
        note: 'Prime Agent 后台服务当前未运行（AgentUI 自身定时任务无需依赖该服务即可独立运行）。',
      }
    }

    const schedRes = await runProcess(prime.path, ['schedule', 'list', '--all', '--json'], {
      env,
      timeoutMs: 6_000,
    }).catch(() => null)

    const nativeSchedules =
      schedRes && schedRes.code === 0 ? parsePrimeScheduleListOutput(schedRes.stdout) : []

    return {
      installed: true,
      version: prime.version,
      daemons,
      daemonRunning: true,
      nativeSchedules,
      checkedAt,
      note:
        nativeSchedules.length === 0
          ? 'Prime 后台服务运行中，当前无原生计划任务。'
          : undefined,
    }
  }
}
