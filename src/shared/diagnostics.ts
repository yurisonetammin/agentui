import { HARNESS_IDS, HARNESS_LABELS, type HarnessId, type HarnessStatus } from './types'

export interface StartupIssue {
  id: string
  harness: HarnessId
  occurredAt: number
  message: string
}

export interface AppDiagnostics {
  version: string
  electron: string
  platform: string
  arch: string
  osRelease: string
  harnesses: Record<HarnessId, HarnessStatus>
  startupIssues: StartupIssue[]
  browser: {
    available: boolean
    version: string | null
    browserMcpCount: number
    otherMcpCount: number
  } | null
  checkedAt: number
}

export function diagnosticHarnessState(status: HarnessStatus): string {
  return status.ready ? '版本检查通过' : status.path ? '探测失败' : '未找到'
}

function safeVersion(version: string | null): string {
  return version && /^v?\d+(?:\.\d+){1,4}(?:[-+][a-z0-9.-]{1,32})?$/i.test(version) ? version : '—'
}

export function formatDiagnosticsReport(data: AppDiagnostics): string {
  return [
    `AgentUI ${data.version}`,
    `Electron ${data.electron} · ${data.platform} ${data.osRelease} (${data.arch})`,
    `采集时间：${new Date(data.checkedAt).toISOString()}`,
    '',
    ...HARNESS_IDS.map((id) => {
      const status = data.harnesses[id]
      const issues = data.startupIssues.filter((issue) => issue.harness === id).length
      return `${HARNESS_LABELS[id]} · ${diagnosticHarnessState(status)} · ${safeVersion(status.version)}${issues ? ` · 启动失败 ${issues} 次` : ''}`
    }),
    '',
    data.browser ? `ego-browser · ${data.browser.available ? safeVersion(data.browser.version) : '未就绪'}` : 'ego-browser · 诊断不可用',
    ...(data.browser ? [`MCP 配置 · 浏览器型 ${data.browser.browserMcpCount} 个 · 其他 ${data.browser.otherMcpCount} 个`] : []),
  ].join('\n')
}
