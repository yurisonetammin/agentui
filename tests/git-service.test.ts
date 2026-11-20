import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../electron/main/git/git-service'

describe('GitService', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  it('reads status, diffs, stages, commits, and manages git worktrees', async () => {
    const base = mkdtempSync(join(tmpdir(), 'agentui-git-test-'))
    const repo = join(base, 'repo')
    tempDirs.push(base)

    execFileSync('git', ['init', '-b', 'main', repo])
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

    const git = new GitService()
    writeFileSync(join(repo, 'README.md'), 'hello\nworld\n', 'utf8')
    writeFileSync(join(repo, 'new.txt'), 'untracked line\n', 'utf8')

    const status = await git.getStatus(repo)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.changes.map((c) => c.path).sort()).toEqual(['README.md', 'new.txt'])

    const trackedDiff = await git.getDiff(repo, 'README.md', false)
    expect(trackedDiff).toContain('+world')

    const untrackedDiff = await git.getDiff(repo, 'new.txt', false)
    expect(untrackedDiff).toContain('+untracked line')

    await git.stageFile(repo, 'README.md')
    const stagedDiff = await git.getDiff(repo, 'README.md', true)
    expect(stagedDiff).toContain('+world')

    const wt = await git.createWorktree(repo, 'feat/test-wt')
    expect(wt.branch).toBe('feat/test-wt')
    const statusAfterWt = await git.getStatus(repo)
    expect(statusAfterWt.worktrees.length).toBe(2)

    await git.removeWorktree(repo, wt.path, false)
    const statusAfterRemove = await git.getStatus(repo)
    expect(statusAfterRemove.worktrees.length).toBe(1)
  })
})
