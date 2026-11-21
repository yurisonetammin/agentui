import type { ExtensionEngine } from '@shared/extensions'
import type { HarnessDiscoveryService } from '../discovery'
import { harnessChildEnvironment, runProcess } from '../process-utils'

export interface EngineCliOptions {
  /** 项目级操作的工作目录（pi -l / omp --scope=project / prime --local）。 */
  cwd?: string | null
  timeoutMs?: number
  maxBytes?: number
}

/** Run a Pi / OMP / Prime CLI subcommand with the documented env fixes applied. */
export async function runEngineCli(
  engine: ExtensionEngine,
  discovery: HarnessDiscoveryService,
  args: readonly string[],
  options: EngineCliOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; combined: string; code: number | null; timedOut: boolean }> {
  const status = discovery.snapshot()[engine]
  if (!status.ready || !status.path) {
    throw new Error(`${status.name ?? engine} CLI 未就绪，无法执行 ${args[0] ?? ''}`.trim())
  }
  const env = harnessChildEnvironment(
    engine,
    status.agentDir,
    engine === 'prime' ? { PRIME_AGENT_TELEMETRY: '0' } : {},
  )
  const res = await runProcess(status.path, [...args], {
    cwd: options.cwd ?? undefined,
    env,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
  })
  return {
    ok: !res.timedOut && res.code === 0,
    stdout: res.stdout,
    stderr: res.stderr,
    combined: `${res.stdout}\n${res.stderr}`.trim(),
    code: res.code,
    timedOut: res.timedOut,
  }
}

export function firstJsonPayload(text: string): string | null {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const arrayStart = trimmed.indexOf('[')
  if (start === -1 && arrayStart === -1) return null
  const from = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart)
  const open = trimmed[from]
  const close = open === '{' ? '}' : ']'
  const end = trimmed.lastIndexOf(close)
  if (end <= from) return null
  return trimmed.slice(from, end + 1)
}
