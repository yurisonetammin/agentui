import type { AgentUiApi } from '@shared/types'

declare global {
  interface Window {
    agentui: AgentUiApi
  }
}

export {}
