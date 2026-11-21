import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HARNESS_IDS, type PersistedState } from '@shared/types'
import { DEFAULT_APPEARANCE, DEFAULT_CONVERSATION, normalizeAppearance, normalizeConversation, normalizeHarnessSettings } from '@shared/settings'
import { isTrustPreset } from '@shared/tool-policy'

const DEFAULT_STATE: PersistedState = {
  projects: [],
  threads: [],
  customBinaryPaths: {},
  appearance: DEFAULT_APPEARANCE,
  conversation: DEFAULT_CONVERSATION,
  defaultProjectTrust: 'approval',
  harnessDefaults: {},
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
        projects: Array.isArray(raw.projects)
          ? raw.projects.map((p) => ({
              ...p,
              trustPreset: isTrustPreset(p.trustPreset) ? p.trustPreset : 'approval',
            }))
          : [],
        threads: Array.isArray(raw.threads)
          ? raw.threads.map((t) => ({ ...t, status: 'idle', lastError: null }))
          : [],
        customBinaryPaths: raw.customBinaryPaths && typeof raw.customBinaryPaths === 'object' ? raw.customBinaryPaths : {},
        appearance: normalizeAppearance(raw.appearance),
        conversation: normalizeConversation(raw.conversation),
        defaultProjectTrust: isTrustPreset(raw.defaultProjectTrust) ? raw.defaultProjectTrust : 'approval',
        harnessDefaults: normalizeHarnessSettings(raw.harnessDefaults),
        activeHarness: HARNESS_IDS.includes(raw.activeHarness as never) ? raw.activeHarness! : 'pi',
        activeProjectId: typeof raw.activeProjectId === 'string' ? raw.activeProjectId : null,
        activeThreadId: typeof raw.activeThreadId === 'string' ? raw.activeThreadId : null,
      }
    } catch {
      return structuredClone(DEFAULT_STATE)
    }
  }

  private saveToDisk(next: PersistedState): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    const cleanState: PersistedState = {
      ...next,
      threads: next.threads.map((t) => ({
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
    const next = this.snapshot()
    fn(next)
    this.saveToDisk(next)
    this.state = next
    return this.snapshot()
  }
}
