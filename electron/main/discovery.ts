import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { HARNESS_IDS, type HarnessId, type HarnessStatus, type PrimeImplementation } from '@shared/types'
import {
  HARNESS_DESCRIPTORS,
  findRunnableCandidate,
  harnessExecutableCandidates,
  runProcess,
} from './process-utils'

export function parseHarnessVersion(rawOutput: string): string | null {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const line = lines[lines.length - 1]
  if (!line) return null
  const tokens = line.split(/\s+/)
  // Scan from the end so suffixes like "2.1.325 (Claude Code)" still resolve.
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const stripped = (tokens[i] ?? '').replace(/^[a-z0-9_-]+\//i, '').replace(/^v/i, '')
    if (/^\d/.test(stripped)) return stripped
  }
  return null
}

function classifyPrimeFromVersion(version: string | null): PrimeImplementation | undefined {
  if (!version) return undefined
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return undefined
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (major > 0 || minor > 9 || (minor === 9 && patch >= 9)) return 'rust'
  return 'typescript'
}

async function probePrimeImplementation(executable: string): Promise<PrimeImplementation> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'agentui-prime-probe-'))
    const res = await runProcess(executable, ['--extension', join(dir, 'missing.ts'), '--version'], {
      timeoutMs: 8_000,
      maxBytes: 32 * 1024,
    })
    return res.code !== 0 || res.timedOut ? 'rust' : 'typescript'
  } catch {
    return 'rust'
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export class HarnessDiscoveryService {
  private statuses: Record<HarnessId, HarnessStatus> = Object.fromEntries(
    HARNESS_IDS.map((id) => [id, this.emptyStatus(id)]),
  ) as Record<HarnessId, HarnessStatus>

  private emptyStatus(id: HarnessId): HarnessStatus {
    const d = HARNESS_DESCRIPTORS[id]
    const home = homedir()
    return {
      id,
      name: d.name,
      path: null,
      version: null,
      ready: false,
      agentDir: d.agentDir(home, process.env),
      sessionRoot: d.sessionRoot(home, process.env),
    }
  }

  snapshot(): Record<HarnessId, HarnessStatus> {
    return structuredClone(this.statuses)
  }

  executable(id: HarnessId): string | null {
    return this.statuses[id].path
  }

  primeImplementation(): PrimeImplementation | undefined {
    return this.statuses.prime.implementation
  }

  private readonly revisions = new Map<HarnessId, number>()

  private nextRevision(id: HarnessId): number {
    const revision = (this.revisions.get(id) ?? 0) + 1
    this.revisions.set(id, revision)
    return revision
  }

  applyProbe(status: HarnessStatus): Record<HarnessId, HarnessStatus> {
    this.nextRevision(status.id)
    this.statuses[status.id] = status
    return this.snapshot()
  }

  async probe(id: HarnessId, explicitPath?: string): Promise<HarnessStatus> {
    const descriptor = HARNESS_DESCRIPTORS[id]
    const home = homedir()
    if (explicitPath !== undefined && !isAbsolute(explicitPath)) {
      return { ...this.emptyStatus(id), error: '请输入可执行文件的绝对路径' }
    }
    const candidates = explicitPath === undefined ? harnessExecutableCandidates(descriptor) : [explicitPath]
    const path = findRunnableCandidate(candidates)
    const base: HarnessStatus = {
      id,
      name: descriptor.name,
      path,
      version: null,
      ready: false,
      agentDir: descriptor.agentDir(home, process.env, path),
      sessionRoot: descriptor.sessionRoot(home, process.env, path),
    }
    if (!path) {
      return {
        ...base,
        error: explicitPath === undefined
          ? `未在 PATH 或默认安装目录找到 ${descriptor.name}`
          : '找不到指定的可执行文件，或该路径无法访问',
      }
    }

    try {
      const result = await runProcess(path, ['--version'], { timeoutMs: 10_000, maxBytes: 32 * 1024 })
      if (result.timedOut) return { ...base, error: '探测 --version 超时' }
      if (result.outputExceeded) return { ...base, error: '版本命令的输出超出限制' }
      if (result.code !== 0) {
        const line = (result.stderr || result.stdout).trim().split(/\r?\n/).pop() || `exit ${result.code}`
        return { ...base, error: line.slice(0, 240) }
      }
      const version = parseHarnessVersion(result.stdout || result.stderr)
      const implementation = id === 'prime' ? classifyPrimeFromVersion(version) ?? await probePrimeImplementation(path) : undefined
      return { ...base, version, implementation, ready: true }
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async refresh(customPaths: Partial<Record<HarnessId, string>> = {}): Promise<Record<HarnessId, HarnessStatus>> {
    await Promise.all(HARNESS_IDS.map(async (id) => {
      const revision = this.nextRevision(id)
      const configured = customPaths[id]
      const preferred = configured ? await this.probe(id, configured) : undefined
      // Previously saved paths can stop existing after an upgrade or move.
      const status = preferred?.path ? preferred : await this.probe(id)
      if (this.revisions.get(id) === revision) this.statuses[id] = status
    }))
    return this.snapshot()
  }
}
