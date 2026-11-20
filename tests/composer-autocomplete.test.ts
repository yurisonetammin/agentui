import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SLASH_COMMANDS,
  applyTriggerInsertion,
  detectComposerTrigger,
  filterSlashCommands,
  fuzzyFilterPaths,
  parseBuiltinSlashCommand,
} from '../src/shared/composer-autocomplete'

describe('composer autocomplete (@file & /slash)', () => {
  it('detects @file triggers after start or whitespace but ignores email addresses', () => {
    expect(detectComposerTrigger('@app', 4)).toEqual({ kind: 'file', query: 'app', start: 0, end: 4 })
    expect(detectComposerTrigger('review @src/main.ts', 19)).toEqual({
      kind: 'file',
      query: 'src/main.ts',
      start: 7,
      end: 19,
    })
    expect(detectComposerTrigger('mail test@example.com', 21)).toBeNull()
    expect(detectComposerTrigger('check (@foo/bar)', 15)).toEqual({
      kind: 'file',
      query: 'foo/bar',
      start: 7,
      end: 15,
    })
  })

  it('detects leading /slash triggers but ignores mid-sentence slashes', () => {
    expect(detectComposerTrigger('/comp', 5)).toEqual({ kind: 'slash', query: 'comp', start: 0, end: 5 })
    expect(detectComposerTrigger('  /for', 6)).toEqual({ kind: 'slash', query: 'for', start: 2, end: 6 })
    expect(detectComposerTrigger('/thinking high', 14)).toBeNull()
    expect(detectComposerTrigger('check src/app.ts', 16)).toBeNull()
  })

  it('applies trigger insertion cleanly with spacing and updated cursor', () => {
    const trig = detectComposerTrigger('fix @app now', 8)!
    const res = applyTriggerInsertion('fix @app now', trig, '@src/renderer/src/App.tsx')
    expect(res.nextText).toBe('fix @src/renderer/src/App.tsx now')
    expect(res.nextCursor).toBe('fix @src/renderer/src/App.tsx'.length)

    const trigEnd = detectComposerTrigger('fix @app', 8)!
    const resEnd = applyTriggerInsertion('fix @app', trigEnd, '@src/App.tsx')
    expect(resEnd.nextText).toBe('fix @src/App.tsx ')
    expect(resEnd.nextCursor).toBe('fix @src/App.tsx '.length)
  })

  it('ranks workspace paths with basename prefix ahead of subsequence matches', () => {
    const paths = [
      'docs/archive/app-plan.md',
      'src/renderer/src/App.tsx',
      'src/shared/a-p-p-helper.ts',
      'electron/main/ipc.ts',
    ]
    const matches = fuzzyFilterPaths(paths, 'app')
    expect(matches[0]).toBe('src/renderer/src/App.tsx')
    expect(matches).toContain('docs/archive/app-plan.md')
    expect(matches).toContain('src/shared/a-p-p-helper.ts')
    expect(matches).not.toContain('electron/main/ipc.ts')
  })

  it('filters slash commands and parses built-in commands', () => {
    const filtered = filterSlashCommands(BUILTIN_SLASH_COMMANDS, 'fo')
    expect(filtered[0]?.name).toBe('fork')

    expect(parseBuiltinSlashCommand('/compact')).toEqual({ type: 'compact' })
    expect(parseBuiltinSlashCommand('/fork')).toEqual({ type: 'fork' })
    expect(parseBuiltinSlashCommand('/thinking high')).toEqual({ type: 'thinking', level: 'high' })
    expect(parseBuiltinSlashCommand('/thinking bogus')).toBeNull()
    expect(parseBuiltinSlashCommand('/skill:review')).toBeNull()
  })
})
