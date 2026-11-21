import type { ThreadRunStatus } from '@shared/types'

const STATUS: Record<ThreadRunStatus, { label: string; color: string }> = {
  idle: { label: '空闲', color: 'idle' },
  starting: { label: '启动中', color: 'streaming' },
  streaming: { label: '运行中', color: 'streaming' },
  compacting: { label: '压缩上下文中', color: 'streaming' },
  waiting_ui: { label: '等待审批', color: 'waiting' },
  disconnected: { label: '连接已断开', color: 'disconnected' },
  error: { label: '运行出错', color: 'error' },
}

export function statusDotClass(status: ThreadRunStatus): string {
  return `dot-${STATUS[status].color}`
}

export function statusLabel(status: ThreadRunStatus): string {
  return STATUS[status].label
}

export function relativeTime(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes === 0) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
