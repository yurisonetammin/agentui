import type { GitTurnChanges, TimelineItem } from './types'

export interface TurnNavEntry {
  turnNumber: number
  userItemId: string
  timelineIndex: number
  promptPreview: string
  timestamp: number
  toolCount: number
  hasError: boolean
  changes: GitTurnChanges | null
  summaryItemId: string | null
}

/**
 * Group a flat conversation timeline into navigable user turns, summarizing
 * each turn's user prompt preview, tool count, error state, and Git diff stats.
 */
export function buildTurnNavEntries(timeline: readonly TimelineItem[]): TurnNavEntry[] {
  const entries: TurnNavEntry[] = []
  let current: TurnNavEntry | null = null

  for (let i = 0; i < timeline.length; i += 1) {
    const item = timeline[i]
    if (item.role === 'user') {
      const firstLine =
        item.text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean) ?? (item.images?.length ? `[图片 ×${item.images.length}]` : '(空消息)')
      const preview = firstLine.length > 64 ? `${firstLine.slice(0, 64)}…` : firstLine
      current = {
        turnNumber: entries.length + 1,
        userItemId: item.id,
        timelineIndex: i,
        promptPreview: preview,
        timestamp: item.timestamp,
        toolCount: 0,
        hasError: false,
        changes: null,
        summaryItemId: null,
      }
      entries.push(current)
      continue
    }

    if (!current) continue

    if (item.role === 'assistant') {
      const calls = Object.values(item.toolCalls)
      current.toolCount += calls.length
      if (item.errorMessage || calls.some((c) => c.status === 'error')) {
        current.hasError = true
      }
    } else if (item.role === 'change-summary') {
      current.changes = item.changes
      current.summaryItemId = item.id
    } else if (item.role === 'notice' && item.kind === 'error') {
      current.hasError = true
    }
  }

  return entries
}
