import { HARNESS_IDS, THINKING_LEVELS, type HarnessId, type ThinkingLevel } from './types'

export interface HarnessDefaults {
  model: { provider: string; id: string } | null
  thinkingLevel: ThinkingLevel | null
}

export interface AppearanceSettings {
  theme: 'system' | 'light' | 'dark'
  conversationWidth: 'standard' | 'wide' | 'full'
  codeFontSize: 12 | 13 | 14 | 16
  reduceMotion: boolean
  terminalPlacement: 'right' | 'bottom'
  /** Closing the main window hides to system tray so scheduled tasks stay active. */
  closeToTray: boolean
}

export interface ConversationSettings {
  enterWhileRunning: 'followUp' | 'steer'
  collapseToolGroups: boolean
}

export const DEFAULT_CONVERSATION: ConversationSettings = {
  enterWhileRunning: 'followUp',
  collapseToolGroups: true,
}

export function normalizeConversation(value?: Partial<ConversationSettings> | null): ConversationSettings {
  return {
    enterWhileRunning: value?.enterWhileRunning === 'steer' ? 'steer' : 'followUp',
    collapseToolGroups: value?.collapseToolGroups !== false,
  }
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  conversationWidth: 'standard',
  codeFontSize: 12,
  reduceMotion: false,
  terminalPlacement: 'right',
  closeToTray: false,
}

export const DEFAULT_HARNESS_SETTINGS: HarnessDefaults = { model: null, thinkingLevel: null }
export const CODE_FONT_SIZES = [12, 13, 14, 16] as const
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
}

export function normalizeAppearance(value?: Partial<AppearanceSettings> | null): AppearanceSettings {
  return {
    theme: value?.theme === 'light' || value?.theme === 'dark' ? value.theme : 'system',
    conversationWidth: value?.conversationWidth === 'wide' || value?.conversationWidth === 'full'
      ? value.conversationWidth : 'standard',
    codeFontSize: value?.codeFontSize && CODE_FONT_SIZES.includes(value.codeFontSize) ? value.codeFontSize : 12,
    reduceMotion: value?.reduceMotion === true,
    terminalPlacement: value?.terminalPlacement === 'bottom' ? 'bottom' : 'right',
    closeToTray: value?.closeToTray === true,
  }
}

export function normalizeHarnessDefaults(value?: Partial<HarnessDefaults> | null): HarnessDefaults {
  const model = value?.model
  const provider = typeof model?.provider === 'string' ? model.provider.trim() : ''
  const id = typeof model?.id === 'string' ? model.id.trim() : ''
  return {
    model: provider && id ? { provider, id } : null,
    thinkingLevel: value?.thinkingLevel && THINKING_LEVELS.includes(value.thinkingLevel) ? value.thinkingLevel : null,
  }
}

export function normalizeHarnessSettings(values?: Partial<Record<HarnessId, HarnessDefaults>> | null) {
  const defaults: Partial<Record<HarnessId, HarnessDefaults>> = {}
  for (const id of HARNESS_IDS) {
    if (values?.[id]) defaults[id] = normalizeHarnessDefaults(values[id])
  }
  return defaults
}
