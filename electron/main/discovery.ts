import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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

  async refresh(customPaths: Partial<Record<HarnessId, string>> = {}): Promise<Record<HarnessId, HarnessStatus>> {
    const home = homedir()
    const entries = await Promise.all(
      HARNESS_IDS.map(async (id): Promise<[HarnessId, HarnessStatus]> => {
        const desc = HARNESS_DESCRIPTORS[id]
        const candidates = harnessExecutableCandidates(desc, customPaths[id])
        const path = findRunnableCandidate(candidates)
        const agentDir = desc.agentDir(home, process.env, path)
        const sessionRoot = desc.sessionRoot(home, process.env, path)

        if (!path) {
          return [
            id,
            {
              id,
              name: desc.name,
              path: null,
              version: null,
              ready: false,
              error: `未在 PATH 或默认安装目录找到 ${desc.name}`,
              agentDir,
              sessionRoot,
            },
          ]
        }

        try {
          const probe = await runProcess(path, ['--version'], {
            timeoutMs: 10_000,
            maxBytes: 32 * 1024,
          })
          if (probe.timedOut) {
            return [
              id,
              {
                id,
                name: desc.name,
                path,
                version: null,
                ready: false,
                error: '探测 --version 超时',
                agentDir,
                sessionRoot,
              },
            ]
          }
          if (probe.code !== 0) {
            const errLine = (probe.stderr || probe.stdout).trim().split(/\r?\n/).pop() || `exit ${probe.code}`
            return [
              id,
              {
                id,
                name: desc.name,
                path,
                version: null,
                ready: false,
                error: errLine.slice(0, 240),
                agentDir,
                sessionRoot,
              },
            ]
          }
          const version = parseHarnessVersion(probe.stdout || probe.stderr)
          let implementation: PrimeImplementation | undefined
          if (id === 'prime') {
            implementation = classifyPrimeFromVersion(version) ?? (await probePrimeImplementation(path))
          }
          return [
            id,
            {
              id,
              name: desc.name,
              path,
              version,
              implementation,
              ready: true,
              agentDir,
              sessionRoot,
            },
          ]
        } catch (err) {
          return [
            id,
            {
              id,
              name: desc.name,
              path,
              version: null,
              ready: false,
              error: err instanceof Error ? err.message : String(err),
              agentDir,
              sessionRoot,
            },
          ]
        }
      }),
    )

    this.statuses = Object.fromEntries(entries) as Record<HarnessId, HarnessStatus>
    return this.snapshot()
  }
}
