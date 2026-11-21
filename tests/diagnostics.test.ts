import { describe, it, expect } from 'vitest'
import { formatDiagnosticsReport, type AppDiagnostics } from '../src/shared/diagnostics'
import { HARNESS_IDS, HARNESS_LABELS } from '../src/shared/types'

describe('copyable diagnostics', () => {
  it('includes useful status and counts while keeping local paths and CLI error data out', () => {
    const harnesses = Object.fromEntries(HARNESS_IDS.map((id) => [id, {
      id, name: HARNESS_LABELS[id], ready: id === 'pi', path: 'C:/private/path.exe',
      agentDir: 'C:/private/agent', sessionRoot: 'C:/private/sessions',
      version: id === 'pi' ? '2.4.0-alpha.1' : '5/C:/private/path',
      error: 'CLI error containing a private value',
    }])) as AppDiagnostics['harnesses']
    const report = formatDiagnosticsReport({
      version: '0.1.0', electron: '35.2.0', platform: 'win32', arch: 'x64', osRelease: '10.0',
      checkedAt: 1, harnesses,
      startupIssues: [{ id: 'one', harness: 'pi', occurredAt: 1, message: 'Private startup details' }],
      browser: { available: true, version: '0.6.3.14', browserMcpCount: 2, otherMcpCount: 1 },
    })
    expect(report).toContain('Pi · 版本检查通过 · 2.4.0-alpha.1 · 启动失败 1 次')
    expect(report).toContain('浏览器型 2 个 · 其他 1 个')
    expect(report).not.toMatch(/private|CLI error/i)
  })
})
