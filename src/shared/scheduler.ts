/**
 * Pure 5-field Cron parser, next-run calculator, and scheduled-task types.
 * Zero external dependencies.
 */

import { HARNESS_IDS, type HarnessId } from './types'
import { isTrustPreset, type TrustPreset } from './tool-policy'

export interface ScheduledTask {
  id: string
  name: string
  /** Standard 5-field Cron expression (min hour dom month dow) or preset (@hourly/@daily/@weekly). */
  cron: string
  projectId: string
  harness: HarnessId
  modelProvider?: string | null
  modelId?: string | null
  trustPreset: TrustPreset
  prompt: string
  enabled: boolean
  notifyOnFailure: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number | null
  lastStatus?: 'success' | 'error' | null
  lastSummary?: string | null
  lastError?: string | null
}

export interface UpsertScheduledTaskInput {
  id?: string
  name: string
  cron: string
  projectId: string
  harness: HarnessId
  modelProvider?: string | null
  modelId?: string | null
  trustPreset?: TrustPreset
  prompt: string
  enabled?: boolean
  notifyOnFailure?: boolean
}

export interface ScheduleRunRecord {
  id: string
  taskId: string
  taskName: string
  projectId: string
  harness: HarnessId
  trigger: 'cron' | 'manual'
  startedAt: number
  finishedAt: number
  status: 'success' | 'error'
  summary?: string | null
  error?: string | null
}

export interface ScheduleSnapshot {
  tasks: ScheduledTask[]
  runs: ScheduleRunRecord[]
  runningTaskIds: string[]
  nextRuns: Record<string, number | null>
}

export interface PrimeDaemonEntry {
  socketPath: string
  status: string
  isDefault?: boolean
  hasTrackedWorkers?: boolean
}

export interface PrimeNativeScheduleItem {
  id?: string
  agent?: string
  schedule?: string
  prompt?: string
  nextRun?: string
  raw: string
}

export interface PrimeHeartbeatStatus {
  installed: boolean
  version: string | null
  daemons: PrimeDaemonEntry[]
  daemonRunning: boolean
  nativeSchedules: PrimeNativeScheduleItem[]
  checkedAt: number
  note?: string
}

export const CRON_PRESETS: ReadonlyArray<{ label: string; expr: string; description: string }> = [
  { label: '每 15 分钟', expr: '*/15 * * * *', description: '每小时的 0/15/30/45 分执行' },
  { label: '每小时整点', expr: '0 * * * *', description: '每小时 00 分执行' },
  { label: '每日 09:00', expr: '0 9 * * *', description: '每天上午 9:00 执行' },
  { label: '工作日 09:30', expr: '30 9 * * 1-5', description: '周一至周五 09:30 执行' },
  { label: '每周一 09:00', expr: '0 9 * * 1', description: '每周一上午 9:00 执行' },
]

const CRON_ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 9 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 9 * * 1',
  '@monthly': '0 9 1 * *',
}

export interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  doms: Set<number>
  months: Set<number>
  dows: Set<number>
  domWildcard: boolean
  dowWildcard: boolean
}

function parseField(
  token: string,
  min: number,
  max: number,
  normalizeValue?: (v: number) => number,
): { values: Set<number>; wildcard: boolean } | null {
  const trimmed = token.trim()
  if (!trimmed) return null
  const out = new Set<number>()
  const wildcard = trimmed === '*'

  for (const segment of trimmed.split(',')) {
    const part = segment.trim()
    if (!part) return null
    const slashParts = part.split('/')
    if (slashParts.length > 2) return null

    const rangePart = slashParts[0]!
    let step = 1
    if (slashParts.length === 2) {
      if (!/^\d+$/.test(slashParts[1]!)) return null
      step = Number(slashParts[1])
      if (!Number.isInteger(step) || step <= 0) return null
    }

    let start = min
    let end = max
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-')
      if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]!) || !/^\d+$/.test(bounds[1]!)) {
        return null
      }
      start = Number(bounds[0])
      end = Number(bounds[1])
      if (start < min || end > max || start > end) return null
    } else {
      if (!/^\d+$/.test(rangePart)) return null
      const val = Number(rangePart)
      if (val < min || val > max) return null
      start = val
      end = slashParts.length === 2 ? max : val
    }

    for (let v = start; v <= end; v += step) {
      out.add(normalizeValue ? normalizeValue(v) : v)
    }
  }

  return out.size > 0 ? { values: out, wildcard } : null
}

export function parseCronExpression(expr: string): ParsedCron | null {
  const raw = expr.trim()
  if (!raw) return null
  const expanded = CRON_ALIASES[raw.toLowerCase()] ?? raw
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5) return null

  const min = parseField(parts[0]!, 0, 59)
  const hour = parseField(parts[1]!, 0, 23)
  const dom = parseField(parts[2]!, 1, 31)
  const month = parseField(parts[3]!, 1, 12)
  const dow = parseField(parts[4]!, 0, 7, (v) => (v === 7 ? 0 : v))

  if (!min || !hour || !dom || !month || !dow) return null
  return {
    minutes: min.values,
    hours: hour.values,
    doms: dom.values,
    months: month.values,
    dows: dow.values,
    domWildcard: dom.wildcard,
    dowWildcard: dow.wildcard,
  }
}

export function isValidCronExpression(expr: string): boolean {
  return parseCronExpression(expr) !== null
}

export function matchesCronDate(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.months.has(date.getMonth() + 1)) return false
  if (!parsed.hours.has(date.getHours())) return false
  if (!parsed.minutes.has(date.getMinutes())) return false

  const domMatch = parsed.doms.has(date.getDate())
  const dowMatch = parsed.dows.has(date.getDay())
  if (parsed.domWildcard && parsed.dowWildcard) return true
  if (parsed.domWildcard) return dowMatch
  if (parsed.dowWildcard) return domMatch
  return domMatch || dowMatch
}

/**
 * Compute the next local wall-clock timestamp (ms) strictly after `afterMs`
 * matching the given Cron expression (searches up to 366 days).
 */
export function nextCronRun(expr: string, afterMs = Date.now()): number | null {
  const parsed = parseCronExpression(expr)
  if (!parsed) return null

  const cursor = new Date(afterMs)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const limitMs = afterMs + 366 * 24 * 60 * 60 * 1000
  while (cursor.getTime() <= limitMs) {
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }

    const domMatch = parsed.doms.has(cursor.getDate())
    const dowMatch = parsed.dows.has(cursor.getDay())
    const dayOk = parsed.domWildcard && parsed.dowWildcard
      ? true
      : parsed.domWildcard
        ? dowMatch
        : parsed.dowWildcard
          ? domMatch
          : domMatch || dowMatch
    if (!dayOk) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }

    if (!parsed.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!parsed.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }

    return cursor.getTime()
  }

  return null
}

export function normalizeScheduledTask(raw: unknown): ScheduledTask | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : null
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 100) : null
  const cron = typeof r.cron === 'string' && isValidCronExpression(r.cron) ? r.cron.trim() : null
  const projectId = typeof r.projectId === 'string' && r.projectId.trim() ? r.projectId.trim() : null
  const harness = HARNESS_IDS.includes(r.harness as HarnessId) ? (r.harness as HarnessId) : null
  const prompt = typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt.trim() : null
  if (!id || !name || !cron || !projectId || !harness || !prompt) return null
  const now = Date.now()
  return {
    id,
    name,
    cron,
    projectId,
    harness,
    modelProvider: typeof r.modelProvider === 'string' && r.modelProvider.trim() ? r.modelProvider.trim() : null,
    modelId: typeof r.modelId === 'string' && r.modelId.trim() ? r.modelId.trim() : null,
    trustPreset: isTrustPreset(r.trustPreset) ? r.trustPreset : 'readonly',
    prompt,
    enabled: r.enabled !== false,
    notifyOnFailure: r.notifyOnFailure !== false,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now,
    lastRunAt: typeof r.lastRunAt === 'number' && Number.isFinite(r.lastRunAt) ? r.lastRunAt : null,
    lastStatus: r.lastStatus === 'success' || r.lastStatus === 'error' ? r.lastStatus : null,
    lastSummary: typeof r.lastSummary === 'string' ? r.lastSummary : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
  }
}

export function parsePrimeStatusOutput(stdout: string): PrimeDaemonEntry[] {
  try {
    const parsed = JSON.parse(stdout.trim())
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const out: PrimeDaemonEntry[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      const socketPath = typeof obj.socketPath === 'string' ? obj.socketPath : String(obj.socket ?? '')
      const status = typeof obj.status === 'string' ? obj.status : 'unknown'
      out.push({
        socketPath,
        status,
        isDefault: obj.isDefault === true,
        hasTrackedWorkers: obj.hasTrackedWorkers === true,
      })
    }
    return out
  } catch {
    return []
  }
}

export function parsePrimeScheduleListOutput(stdout: string): PrimeNativeScheduleItem[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { schedules?: unknown[] })?.schedules)
        ? (parsed as { schedules: unknown[] }).schedules
        : []
    return arr
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : undefined,
        agent: typeof item.agent === 'string' ? item.agent : typeof item.target === 'string' ? item.target : undefined,
        schedule: typeof item.cron === 'string'
          ? item.cron
          : typeof item.schedule === 'string'
            ? item.schedule
            : typeof item.runAt === 'string'
              ? item.runAt
              : undefined,
        prompt: typeof item.prompt === 'string'
          ? item.prompt
          : typeof item.message === 'string'
            ? item.message
            : undefined,
        nextRun: typeof item.nextRunAt === 'string' ? item.nextRunAt : undefined,
        raw: JSON.stringify(item),
      }))
  } catch {
    return []
  }
}
