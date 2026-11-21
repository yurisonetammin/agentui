import { describe, expect, it } from 'vitest'
import { matchGlobalShortcut, runningMessageAction, shortcutHints, SHORTCUT_HINTS, type ShortcutKeyEventLike } from '../src/shared/shortcuts'

function keyEvent(overrides: Partial<ShortcutKeyEventLike> & { key: string }): ShortcutKeyEventLike {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...overrides,
  }
}

describe('matchGlobalShortcut', () => {
  it('matches primary global shortcuts with Ctrl or Cmd', () => {
    expect(matchGlobalShortcut(keyEvent({ key: 'n', ctrlKey: true }))).toBe('new-thread')
    expect(matchGlobalShortcut(keyEvent({ key: 'K', metaKey: true }))).toBe('open-palette')
    expect(matchGlobalShortcut(keyEvent({ key: 'l', ctrlKey: true }))).toBe('focus-composer')
    expect(matchGlobalShortcut(keyEvent({ key: '1', ctrlKey: true }))).toBe('switch-pi')
    expect(matchGlobalShortcut(keyEvent({ key: '2', ctrlKey: true }))).toBe('switch-omp')
    expect(matchGlobalShortcut(keyEvent({ key: '3', ctrlKey: true }))).toBe('switch-prime')
    expect(matchGlobalShortcut(keyEvent({ key: ',', ctrlKey: true }))).toBe('toggle-settings')
    expect(matchGlobalShortcut(keyEvent({ key: '/', ctrlKey: true }))).toBe('toggle-shortcuts')
    expect(matchGlobalShortcut(keyEvent({ key: 'Escape' }))).toBe('escape')
  })

  it('distinguishes Shift combos and ignores IME composition or Alt combos', () => {
    expect(matchGlobalShortcut(keyEvent({ key: 'D', ctrlKey: true, shiftKey: true }))).toBe('toggle-diff')
    expect(matchGlobalShortcut(keyEvent({ key: 'd', ctrlKey: true }))).toBeNull()
    expect(matchGlobalShortcut(keyEvent({ key: 'W', ctrlKey: true, shiftKey: true }))).toBe('open-worktrees')
    expect(matchGlobalShortcut(keyEvent({ key: 'w', ctrlKey: true }))).toBeNull()
    expect(matchGlobalShortcut(keyEvent({ key: 'n', ctrlKey: true, isComposing: true }))).toBeNull()
    expect(matchGlobalShortcut(keyEvent({ key: 'n', ctrlKey: true, altKey: true }))).toBeNull()
    expect(matchGlobalShortcut(keyEvent({ key: 'Escape', shiftKey: true }))).toBeNull()
  })

  it('publishes both global and composer hints', () => {
    expect(SHORTCUT_HINTS.some((h) => h.scope === 'global')).toBe(true)
    expect(SHORTCUT_HINTS.some((h) => h.scope === 'composer')).toBe(true)
  })

  it('keeps running message action and help text aligned when the shortcuts are swapped', () => {
    expect(runningMessageAction('followUp', false)).toBe('followUp')
    expect(runningMessageAction('followUp', true)).toBe('steer')
    expect(runningMessageAction('steer', false)).toBe('steer')
    expect(runningMessageAction('steer', true)).toBe('followUp')
    const enterHints = shortcutHints('steer').filter((hint) => ['Enter', 'Ctrl+Enter'].includes(hint.keys.join('+')))
    expect(enterHints.map((hint) => hint.description)).toEqual([
      '空闲时发送 · 运行中引导（Steer）',
      '空闲时发送 · 运行中排队（Follow-up）',
    ])
  })
})
