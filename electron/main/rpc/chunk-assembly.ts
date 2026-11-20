import { performance } from 'node:perf_hooks'
import { DEFAULT_MAX_FRAME_BYTES } from './jsonl'

export type RpcObject = Record<string, unknown>

interface ChunkAssembly {
  count: number
  nextIndex: number
  bytes: number
  parts: Buffer[]
  expiresAt: number
}

export interface RpcChunkAssemblyHost {
  readonly agentName: string
  deliver(frame: unknown): void
  emit(event: RpcObject): void
  active(): boolean
}

const MAX_RPC_CHUNK_COUNT = 4096
const MAX_CONCURRENT_CHUNK_IDS = 4
const INACTIVITY_MS = 30_000

/**
 * Reassembles OMP v2 base64 `rpc_chunk` sequences per `chunkId`, bounded by
 * concurrency and maximum frame bytes.
 */
export class RpcChunkAssembler {
  private readonly abandoned = new Set<string>()
  private readonly assemblies = new Map<string, ChunkAssembly>()
  private sweepTimer: NodeJS.Timeout | null = null
  private accepting = true

  constructor(
    private readonly host: RpcChunkAssemblyHost,
    private readonly now: () => number = () => performance.now(),
  ) {}

  accept(frame: RpcObject): void {
    if (!this.accepting) return
    const chunkId = frame.chunkId
    if (typeof chunkId !== 'string' || !chunkId || chunkId.length > 128) {
      this.failReassembly(undefined, 'chunked frame carried an invalid chunkId')
      return
    }
    if (this.abandoned.has(chunkId)) return
    const index = frame.index
    const count = frame.count
    if (
      !Number.isSafeInteger(index) ||
      Number(index) < 0 ||
      !Number.isSafeInteger(count) ||
      Number(count) < 1 ||
      Number(count) > MAX_RPC_CHUNK_COUNT ||
      typeof frame.data !== 'string'
    ) {
      this.failReassembly(chunkId, 'chunked frame carried invalid sequencing')
      return
    }

    if (this.expire(chunkId) && index !== 0) return
    const existing = this.assemblies.get(chunkId)
    if (!existing) {
      if (index !== 0) {
        this.failReassembly(chunkId, 'chunk indices arrived out of order')
        return
      }
      if (this.assemblies.size >= MAX_CONCURRENT_CHUNK_IDS) {
        this.failReassembly(chunkId, 'too many concurrent chunk reassemblies')
        return
      }
    } else if (index !== existing.nextIndex || count !== existing.count) {
      this.failReassembly(chunkId, 'chunk indices arrived out of order')
      return
    }

    if (frame.data.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(frame.data)) {
      this.failReassembly(chunkId, 'chunk data was not valid base64')
      return
    }
    const decoded = Buffer.from(frame.data, 'base64')
    if (frame.byteLength !== undefined && frame.byteLength !== decoded.length) {
      this.failReassembly(chunkId, 'chunk byteLength did not match its data')
      return
    }

    const current: ChunkAssembly = existing ?? {
      count: Number(count),
      nextIndex: 0,
      bytes: 0,
      parts: [],
      expiresAt: 0,
    }
    if (current.bytes + decoded.length > DEFAULT_MAX_FRAME_BYTES) {
      this.failReassembly(chunkId, 'chunked frame exceeded maximum frame size')
      return
    }

    current.bytes += decoded.length
    current.parts.push(decoded)
    current.nextIndex += 1
    if (!existing || decoded.length > 0) {
      current.expiresAt = this.now() + INACTIVITY_MS
    }

    if (current.nextIndex < current.count) {
      this.assemblies.set(chunkId, current)
      this.rescheduleSweep()
      return
    }

    this.assemblies.delete(chunkId)
    this.rescheduleSweep()
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(current.parts).toString('utf8'))
    } catch {
      this.dispose()
      this.host.emit({
        type: 'transport_limit',
        kind: 'frame',
        error: `${this.host.agentName} emitted a malformed chunked frame`,
      })
      return
    }
    this.host.deliver(parsed)
  }

  close(): void {
    this.accepting = false
    this.dispose()
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer)
      this.sweepTimer = null
    }
    this.assemblies.clear()
  }

  private failReassembly(chunkId: string | undefined, error: string): void {
    if (chunkId !== undefined) {
      this.assemblies.delete(chunkId)
      this.abandoned.add(chunkId)
      while (this.abandoned.size > 16) {
        const oldest = this.abandoned.values().next().value
        if (oldest !== undefined) this.abandoned.delete(oldest)
      }
      this.rescheduleSweep()
    }
    this.host.emit({ type: 'transport_limit', kind: 'chunk', error })
  }

  private rescheduleSweep(): void {
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer)
      this.sweepTimer = null
    }
    if (this.assemblies.size === 0 || !this.host.active()) return
    const deadline = Math.min(...[...this.assemblies.values()].map((a) => a.expiresAt))
    const timer = setTimeout(() => {
      if (this.sweepTimer !== timer) return
      this.sweepTimer = null
      this.expire()
    }, Math.max(0, deadline - this.now()))
    timer.unref()
    this.sweepTimer = timer
  }

  private expire(wantedChunkId?: string): boolean {
    const t = this.now()
    let expiredAny = false
    let wantedExpired = false
    for (const [chunkId, assembly] of this.assemblies) {
      if (assembly.expiresAt > t) continue
      this.assemblies.delete(chunkId)
      this.abandoned.add(chunkId)
      expiredAny = true
      if (chunkId === wantedChunkId) wantedExpired = true
      this.host.emit({
        type: 'transport_limit',
        kind: 'chunk',
        error: 'RPC chunk assembly expired after inactivity',
      })
    }
    if (expiredAny || this.sweepTimer === null) this.rescheduleSweep()
    return wantedExpired
  }
}
