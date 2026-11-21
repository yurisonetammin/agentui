import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  aggregateUsage,
  extractUsageRecordsFromSession,
  parseOmpStatsJson,
  parseOmpUsageJson,
  parsePrimeSessionsJson,
  type AccountQuota,
  type EngineGlobalUsage,
  type UsageFilters,
  type UsageRecord,
  type UsageReport,
} from '@shared/extensions'
import type { ContextUsageInfo, HarnessId } from '@shared/types'
import type { HarnessDiscoveryService } from './discovery'
import { runEngineCli, firstJsonPayload } from './extensions/engine-cli'
import type { StateStore } from './store'
import type { RuntimeManager } from './rpc/manager'

const REPORT_CACHE_TTL = 15_000
const MAX_SESSION_FILES = 400

interface SessionScan {
  threadId: string
  engine: HarnessId
  projectId: string | null
  sessionPath: string
  createdAt: number
}

/**
 * 「使用情况」报表：
 * - AgentUI 项目统计：从会话事件与原生 .jsonl 记录提取单次模型调用用量，
 *   按记录键全局去重（恢复会话、分叉、重复读取历史不会重复入账）。
 * - 引擎全局统计（omp stats / prime sessions）单独展示，不与项目明细相加。
 * - 账户额度接 `omp usage --json`；缺失的 Token / 缓存 / 费用标为「未提供」。
 */
export class UsageService {
  private readonly fileCache = new Map<string, { mtimeMs: number; size: number; records: UsageRecord[] }>()
  private reportCache: { report: UsageReport; filtersKey: string } | null = null

  constructor(
    private readonly store: StateStore,
    private readonly discovery: HarnessDiscoveryService,
    private readonly runtimeManager: RuntimeManager,
  ) {}

  async getReport(filters: UsageFilters = {}, refresh = false): Promise<UsageReport> {
    const filtersKey = JSON.stringify(filters)
    if (!refresh && this.reportCache && this.reportCache.filtersKey === filtersKey && Date.now() - this.reportCache.report.fetchedAt < REPORT_CACHE_TTL) {
      return this.reportCache.report
    }

    const warnings: string[] = []
    const { records, sessions } = this.collectRecords(warnings)

    // 运行中会话：get_session_stats 校验会话总量 + 上下文占用
    const liveTargets = sessions
      .filter((s) => this.runtimeManager.isRuntimeAlive(s.threadId))
      .slice(0, 24)
    const liveUsages = new Map<string, ContextUsageInfo>()
    await Promise.all(liveTargets.map(async (session) => {
      const usage = await this.runtimeManager.getSessionUsageSnapshot(session.threadId)
      if (usage) liveUsages.set(session.threadId, usage)
    }))

    const aggregated = aggregateUsage(records, filters)
    const sessionsById = new Map(sessions.map((s) => [s.threadId, s]))
    const reportSessions = aggregated.sessions.map((row) => {
      const session = sessionsById.get(row.threadId)
      const live = liveUsages.get(row.threadId)
      return {
        ...row,
        title: session ? this.threadTitle(row.threadId) : row.threadId.slice(0, 8),
        liveContextTokens: live?.tokens ?? null,
        validated: live !== undefined,
      }
    })

    const engineGlobals: EngineGlobalUsage[] = []
    const ompStatus = this.discovery.snapshot().omp
    if (ompStatus.ready) {
      engineGlobals.push(await this.fetchOmpGlobal().catch((err) => this.unavailableGlobal('omp', 'omp stats --json', err)))
    }
    const primeStatus = this.discovery.snapshot().prime
    if (primeStatus.ready) {
      engineGlobals.push(await this.fetchPrimeGlobal().catch((err) => this.unavailableGlobal('prime', 'prime-agent sessions --json', err)))
    }

    const accountQuota: AccountQuota | null = ompStatus.ready
      ? await this.fetchOmpQuota().catch((err: unknown) => ({
          available: false,
          source: 'omp usage --json',
          providers: [],
          note: err instanceof Error ? err.message : String(err),
        }))
      : null

    const contextUsage = [...liveUsages.entries()].map(([threadId, usage]) => ({
      ...usage,
      threadId,
      title: this.threadTitle(threadId),
      engine: sessionsById.get(threadId)?.engine ?? 'pi',
    }))

    if (records.length === 0) {
      warnings.push('尚未在本地会话记录中找到用量数据；完成至少一轮对话后这里会出现统计。')
    }
    if (!ompStatus.ready) warnings.push('OMP 未就绪：引擎全局统计与账户额度不可用。')
    if (!primeStatus.ready) warnings.push('Prime Agent 未就绪：全局统计不可用。')

    const report: UsageReport = {
      fetchedAt: Date.now(),
      totals: aggregated.totals,
      byDay: aggregated.byDay,
      byModel: aggregated.byModel,
      byProject: aggregated.byProject.map((row) => ({
        ...row,
        projectName: row.projectId ? this.projectName(row.projectId) : '未关联项目',
      })),
      sessions: reportSessions,
      contextUsage,
      engineGlobals,
      accountQuota,
      warnings,
    }
    this.reportCache = { report, filtersKey }
    return report
  }

  private collectRecords(warnings: string[]): { records: UsageRecord[]; sessions: SessionScan[] } {
    const state = this.store.snapshot()
    const allThreads = state.threads
      .filter((t) => t.sessionPath && !/^(codex|acp|dsh):/.test(t.sessionPath))
      .sort((a, b) => a.createdAt - b.createdAt)
    if (allThreads.length > MAX_SESSION_FILES) {
      warnings.push(`会话数量超过 ${MAX_SESSION_FILES}，仅统计最近的 ${MAX_SESSION_FILES} 个。`)
    }
    const threads = allThreads.slice(-MAX_SESSION_FILES)

    const sessions: SessionScan[] = []
    const claimed = new Set<string>()
    const records: UsageRecord[] = []

    for (const thread of threads) {
      const sessionPath = thread.sessionPath!
      let stat
      try {
        if (!existsSync(sessionPath)) continue
        stat = statSync(sessionPath)
        if (!stat.isFile()) continue
      } catch {
        continue
      }
      sessions.push({
        threadId: thread.id,
        engine: thread.harness,
        projectId: thread.projectId,
        sessionPath,
        createdAt: thread.createdAt,
      })

      const cached = this.fileCache.get(sessionPath)
      let fileRecords: UsageRecord[]
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        fileRecords = cached.records
      } else {
        let content = ''
        try {
          content = readFileSync(sessionPath, 'utf8')
        } catch {
          continue
        }
        fileRecords = extractUsageRecordsFromSession(sessionPath, content, {
          engine: thread.harness,
          threadId: thread.id,
          projectId: thread.projectId,
        })
        if (this.fileCache.size > 600) this.fileCache.clear()
        this.fileCache.set(sessionPath, { mtimeMs: stat.mtimeMs, size: stat.size, records: fileRecords })
      }

      // 以单次模型调用为单位全局去重：原始会话与分叉/恢复副本共享同一条记录键，
      // 最早创建的会话先入账，其余会话的重复记录被丢弃。
      for (const record of fileRecords) {
        if (claimed.has(record.key)) continue
        claimed.add(record.key)
        records.push(record)
      }
    }

    if (threads.length > MAX_SESSION_FILES) {
      warnings.push(`会话数量超过 ${MAX_SESSION_FILES}，仅统计最近的 ${MAX_SESSION_FILES} 个。`)
    }
    return { records, sessions }
  }

  private threadTitle(threadId: string): string {
    const thread = this.store.snapshot().threads.find((t) => t.id === threadId)
    return thread?.title ?? threadId.slice(0, 8)
  }

  private projectName(projectId: string): string {
    return this.store.snapshot().projects.find((p) => p.id === projectId)?.name ?? '未知项目'
  }

  private async fetchOmpGlobal(): Promise<EngineGlobalUsage> {
    const res = await runEngineCli('omp', this.discovery, ['stats', '--json'], { timeoutMs: 90_000, maxBytes: 8 * 1024 * 1024 })
    const payload = firstJsonPayload(res.combined || res.stdout)
    const parsed = payload ? parseOmpStatsJson(payload) : null
    if (!parsed) {
      return {
        engine: 'omp', label: 'OMP 引擎全局统计', source: 'omp stats --json', available: false,
        note: '无法解析 omp stats 输出',
      }
    }
    return parsed
  }

  private async fetchPrimeGlobal(): Promise<EngineGlobalUsage> {
    const res = await runEngineCli('prime', this.discovery, ['sessions', '--json'], { timeoutMs: 30_000 })
    const payload = firstJsonPayload(res.combined || res.stdout)
    const parsed = payload ? parsePrimeSessionsJson(payload) : { usage: null, errors: [res.combined.slice(0, 300)] }
    if (!parsed.usage) {
      const daemonHint = /daemon/i.test(res.combined) ? '需要 Prime daemon 正在运行（prime-agent status 查看）' : undefined
      return {
        engine: 'prime', label: 'Prime Agent 全局统计', source: 'prime-agent sessions --json', available: false,
        note: daemonHint ?? (parsed.errors.join('；') || '没有可统计的会话'),
      }
    }
    return parsed.usage
  }

  private async fetchOmpQuota(): Promise<AccountQuota> {
    const res = await runEngineCli('omp', this.discovery, ['usage', '--json'], { timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 })
    const payload = firstJsonPayload(res.combined || res.stdout)
    if (!payload) {
      return { available: false, source: 'omp usage --json', providers: [], note: 'omp usage 无输出' }
    }
    return parseOmpUsageJson(payload)
  }

  private unavailableGlobal(engine: HarnessId, source: string, err: unknown): EngineGlobalUsage {
    return {
      engine,
      label: engine === 'omp' ? 'OMP 引擎全局统计' : 'Prime Agent 全局统计',
      source,
      available: false,
      note: err instanceof Error ? err.message : String(err),
    }
  }
}
