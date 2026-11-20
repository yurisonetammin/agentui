import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PersistedState } from '@shared/types'

const DEFAULT_STATE: PersistedState = {
  projects: [],
  threads: [],
  customBinaryPaths: {},
  activeHarness: 'pi',
  activeProjectId: null,
  activeThreadId: null,
}

export class StateStore {
  private state: PersistedState

  constructor(private readonly filePath = join(homedir(), '.agentui', 'state.json')) {
    this.state = this.loadFromDisk()
  }

  private loadFromDisk(): PersistedState {
    try {
      if (!existsSync(this.filePath)) return structuredClone(DEFAULT_STATE)
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedState>
      return {
        projects: Array.isArray(raw.projects) ? raw.projects : [],
        threads: Array.isArray(raw.threads)
          ? raw.threads.map((t) => ({ ...t, status: 'idle', lastError: null }))
          : [],
        customBinaryPaths: raw.customBinaryPaths && typeof raw.customBinaryPaths === 'object' ? raw.customBinaryPaths : {},
        activeHarness: raw.activeHarness === 'omp' || raw.activeHarness === 'prime' ? raw.activeHarness : 'pi',
        activeProjectId: typeof raw.activeProjectId === 'string' ? raw.activeProjectId : null,
        activeThreadId: typeof raw.activeThreadId === 'string' ? raw.activeThreadId : null,
      }
    } catch {
      return structuredClone(DEFAULT_STATE)
    }
  }

  private saveToDisk(): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    const cleanState: PersistedState = {
      ...this.state,
      threads: this.state.threads.map((t) => ({
        ...t,
        status: 'idle',
        lastError: null,
      })),
    }
    writeFileSync(tmp, JSON.stringify(cleanState, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  snapshot(): PersistedState {
    return structuredClone(this.state)
  }

  mutate(fn: (draft: PersistedState) => void): PersistedState {
    fn(this.state)
    this.saveToDisk()
    return this.snapshot()
  }
}
