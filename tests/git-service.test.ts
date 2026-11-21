import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

  it('compares a turn with its dirty starting point without changing the real index', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agentui-git-turn-test-'))
    tempDirs.push(repo)
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    run(['init', '-b', 'main'])
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test User'])
    writeFileSync(join(repo, 'tracked.txt'), 'committed\n')
    writeFileSync(join(repo, 'rename-me.txt'), 'unchanged content\n')
    run(['add', '.'])
    run(['commit', '-m', 'initial'])

    writeFileSync(join(repo, 'tracked.txt'), 'committed\npre-existing\n')
    run(['add', 'tracked.txt'])
    writeFileSync(join(repo, '.gitattributes'), 'tracked.txt filter=fixture\n')
    run(['config', 'filter.fixture.clean', 'exit 55'])
    run(['config', 'filter.fixture.required', 'true'])
    writeFileSync(join(repo, 'existing-untracked.txt'), 'kept\n')
    const indexBefore = readFileSync(join(repo, '.git', 'index'))
    const git = new GitService()
    const turn = await git.beginTurn(repo)
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'committed\nreplacement\n')
      writeFileSync(join(repo, 'new.txt'), 'line one\nline two\n')
      renameSync(join(repo, 'rename-me.txt'), join(repo, 'renamed.txt'))
      const result = await turn.finish()
      expect(result.changes).toEqual({ files: 3, added: 3, removed: 1 })
      expect(result.diff).toContain('-pre-existing')
      expect(result.diff).not.toContain('existing-untracked.txt')
      expect(readFileSync(join(repo, '.git', 'index'))).toEqual(indexBefore)
    } finally {
      await turn.discard()
    }
  })
})
