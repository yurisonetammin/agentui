import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessToolRequest, isReadOnlyCommand, pickSelectOption } from '../src/shared/tool-policy'
import { isPathInside, isRealPathInside } from '../electron/main/process-utils'
import { WorkspaceBrowserService } from '../electron/main/workspace-browser'

describe('tool-policy hardening', () => {
  it('rejects newline-chained commands as read-only', () => {
    expect(isReadOnlyCommand('ls\ntouch pwned')).toBe(false)
    expect(isReadOnlyCommand('ls\r\necho hi')).toBe(false)
    expect(isReadOnlyCommand('ls -la')).toBe(true)
  })

  it('does not treat mutating git branch/tag/remote as read-only', () => {
    expect(isReadOnlyCommand('git branch -D main')).toBe(false)
    expect(isReadOnlyCommand('git branch feature')).toBe(false)
    expect(isReadOnlyCommand('git tag -d v1')).toBe(false)
    expect(isReadOnlyCommand('git remote remove origin')).toBe(false)
    expect(isReadOnlyCommand('git branch')).toBe(true)
    expect(isReadOnlyCommand('git branch -a')).toBe(true)
    expect(isReadOnlyCommand('git remote -v')).toBe(true)
    expect(isReadOnlyCommand('git status')).toBe(true)
  })

  it('rejects find write flags', () => {
    expect(isReadOnlyCommand('find . -fprint out.txt')).toBe(false)
    expect(isReadOnlyCommand('find . -name x')).toBe(true)
  })

  it('flags force pushes regardless of flag position', () => {
    for (const cmd of ['git push origin main --force', 'git push origin main -f', 'git push -f origin main']) {
      expect(assessToolRequest({ title: 'x', message: JSON.stringify({ command: cmd }) }).level).toBe('high')
    }
  })

  it('flags more destructive variants', () => {
    for (const cmd of ['rd /s /q C:\\x', 'rm --recursive --force /tmp/x', 'git branch -D main', 'git restore .']) {
      expect(assessToolRequest({ title: 'x', message: JSON.stringify({ command: cmd }) }).level).toBe('high')
    }
  })

  it('never falls back to options[0] or an always-allow option', () => {
    expect(pickSelectOption(['Deny', 'Cancel'], true)).toBeUndefined()
    expect(pickSelectOption(['Allow always', 'Allow once', 'Reject once'], true)).toBe('Allow once')
    expect(pickSelectOption(['Allow always'], true)).toBeUndefined()
    expect(pickSelectOption(['Allow once', 'Reject once'], false)).toBe('Reject once')
  })
})

describe('path containment', () => {
  it('does not misclassify names starting with ..', () => {
    expect(isPathInside('/a/b', '/a/b/..foo')).toBe(true)
    expect(isPathInside('/a/b', '/a/b/../c')).toBe(false)
  })

  it('blocks symlink escapes and bounds file reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentui-sec-'))
    const outside = mkdtempSync(join(tmpdir(), 'agentui-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      writeFileSync(join(root, 'big.txt'), 'a'.repeat(600_000))
      mkdirSync(join(root, 'sub'))
      let linked = false
      try {
        symlinkSync(outside, join(root, 'link'), 'junction')
        linked = true
      } catch {
        linked = false
      }
      const svc = new WorkspaceBrowserService()
      const big = svc.readFile(root, 'big.txt')
      expect(big.truncated).toBe(true)
      expect(big.content.length).toBeLessThanOrEqual(512 * 1024)
      if (linked) {
        expect(isRealPathInside(root, join(root, 'link', 'secret.txt'))).toBe(false)
        expect(() => svc.readFile(root, 'link/secret.txt')).toThrow()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
