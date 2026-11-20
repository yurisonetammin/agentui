import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { HarnessId, ModelCatalogResult, ModelDescriptor, ThinkingLevel } from '@shared/types'
import { THINKING_LEVELS } from '@shared/types'
import type { HarnessDiscoveryService } from './discovery'
import {
  harnessChildEnvironment,
  killProcessTree,
  prepareExecutableSpawn,
  runProcess,
} from './process-utils'
import { StrictJsonlDecoder } from './rpc/jsonl'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseThinkingLevels(reasoning: boolean, raw: unknown): ThinkingLevel[] {
  if (Array.isArray(raw)) {
    const reported = new Set(raw.filter((x): x is string => typeof x === 'string'))
    if (!reasoning && reported.size === 0) return ['off']
    return THINKING_LEVELS.filter((lvl) => lvl === 'off' || reported.has(lvl))
  }
  if (isRecord(raw)) {
    const active = new Set(
      Object.entries(raw)
        .filter(([, val]) => typeof val === 'string')
        .map(([k]) => k),
    )
    if (!reasoning && active.size === 0) return ['off']
    return THINKING_LEVELS.filter((lvl) => lvl === 'off' || active.has(lvl))
  }
  return reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off']
}

function normalizeModelEntry(raw: unknown): ModelDescriptor | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : undefined
  const provider = typeof raw.provider === 'string' ? raw.provider : undefined
  if (!id || !provider) return null
  const name = typeof raw.name === 'string' && raw.name ? raw.name : id
  const reasoning = raw.reasoning === true
  const contextWindow = typeof raw.contextWindow === 'number' && raw.contextWindow > 0 ? raw.contextWindow : 128_000
  const maxTokens = typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined
  const availableThinkingLevels = parseThinkingLevels(reasoning, raw.thinking ?? raw.thinkingLevels)
  return {
    provider,
    id,
    name,
    reasoning,
    contextWindow,
    maxTokens,
    availableThinkingLevels,
    fastModeSupported: raw.fastModeSupported === true,
  }
}

export class ModelCatalogService {
  private readonly cache = new Map<HarnessId, ModelCatalogResult>()

  constructor(private readonly discovery: HarnessDiscoveryService) {}

  async getCatalog(harness: HarnessId, refresh = false): Promise<ModelCatalogResult> {
    if (!refresh) {
      const cached = this.cache.get(harness)
      if (cached && Date.now() - cached.fetchedAt < 120_000) return cached
    }

    const status = this.discovery.snapshot()[harness]
    const executable = status.path
    if (!executable) {
      return {
        harness,
        models: [],
        warning: `${harness.toUpperCase()} 未就绪，无法读取模型列表`,
        fetchedAt: Date.now(),
      }
    }

    const childEnv = harnessChildEnvironment(
      harness,
      status.agentDir,
      harness === 'prime' ? { PRIME_AGENT_TELEMETRY: '0' } : {},
    )

    try {
      const models =
        harness === 'omp'
          ? await this.fetchOmpModels(executable, childEnv)
          : await this.fetchRpcModels(
              executable,
              harness === 'pi' ? ['--mode', 'rpc', '--no-session', '--offline'] : ['--mode', 'rpc', '--no-session'],
              childEnv,
              harness === 'prime' ? 25_000 : 12_000,
            )
      const result: ModelCatalogResult = {
        harness,
        models,
        fetchedAt: Date.now(),
        warning: models.length === 0 ? `未检测到已配置凭证的模型（请先在终端用 ${harness} 登录或配置 API Key）` : undefined,
      }
      this.cache.set(harness, result)
      return result
    } catch (err) {
      const stale = this.cache.get(harness)
      const message = err instanceof Error ? err.message : String(err)
      if (stale) {
        return { ...stale, warning: `模型刷新失败，已使用缓存 (${message})` }
      }
      return {
        harness,
        models: [],
        warning: message,
        fetchedAt: Date.now(),
      }
    }
  }

  private async fetchOmpModels(executable: string, childEnv: NodeJS.ProcessEnv): Promise<ModelDescriptor[]> {
    const res = await runProcess(executable, ['models', '--json'], {
      env: childEnv,
      timeoutMs: 12_000,
      maxBytes: 4 * 1024 * 1024,
    })
    if (res.timedOut) throw new Error('omp models --json 超时')
    if (res.code !== 0) {
      // Fallback to RPC probe if CLI subcommand fails
      return this.fetchRpcModels(executable, ['--mode', 'rpc', '--no-session'], childEnv, 15_000)
    }
    const parsed = JSON.parse(res.stdout) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : []
    return list.map(normalizeModelEntry).filter((m): m is ModelDescriptor => m !== null)
  }

  private fetchRpcModels(
    executable: string,
    args: string[],
    childEnv: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<ModelDescriptor[]> {
    const invocation = prepareExecutableSpawn(executable, args, childEnv)
    return new Promise((resolvePromise, rejectPromise) => {
      const reqId = randomUUID()
      const child = spawn(invocation.file, invocation.args, {
        env: invocation.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let settled = false
      let stderr = ''
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.stdin.end() } catch { /* ignore */ }
        if (child.pid) void killProcessTree(child.pid)
        fn()
      }

      const timer = setTimeout(() => {
        finish(() => rejectPromise(new Error('模型列表探测超时')))
      }, timeoutMs)
      timer.unref()

      const decoder = new StrictJsonlDecoder((line) => {
        try {
          const frame = JSON.parse(line) as unknown
          if (!isRecord(frame)) return
          if (frame.type === 'response' && frame.id === reqId) {
            if (frame.success !== true) {
              finish(() => rejectPromise(new Error(String(frame.error ?? 'get_available_models failed'))))
              return
            }
            const data = isRecord(frame.data) ? frame.data : {}
            const list = Array.isArray(data.models) ? data.models : []
            const models = list.map(normalizeModelEntry).filter((m): m is ModelDescriptor => m !== null)
            finish(() => resolvePromise(models))
          }
        } catch {
          // ignore non-json noise
        }
      })

      child.stdout.on('data', (chunk: Buffer) => {
        try {
          decoder.push(chunk)
        } catch (err) {
          finish(() => rejectPromise(err instanceof Error ? err : new Error(String(err))))
        }
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > 2048) stderr = stderr.slice(-2048)
      })

      child.once('error', (err) => finish(() => rejectPromise(err)))
      child.once('close', (code) => {
        finish(() => rejectPromise(new Error(`探测进程提前退出 (${code}): ${stderr.trim()}`)))
      })

      child.stdin.write(`${JSON.stringify({ id: reqId, type: 'get_available_models' })}\n`)
    })
  }
}
