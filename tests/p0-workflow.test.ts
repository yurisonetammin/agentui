import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildComparePrUrl,
  cleanGeneratedCommitMessage,
  parseRemoteRepoWebUrl,
  synthesizeHeuristicCommitMessage,
} from '../src/shared/git-pr'
import {
  formatDiffCommentForComposer,
  parseUnifiedDiffLines,
  summarizeDiffSelection,
} from '../src/shared/diff-lines'
import {
  assessToolRequest,
  decideApproval,
  deriveCommandPrefixPattern,
  matchPermissionRules,
  normalizePermissionRules,
  type ToolPermissionRule,
} from '../src/shared/tool-policy'
import { buildTurnNavEntries } from '../src/shared/turn-navigator'
import type { ExtensionUiRequest, ExtensionUiResponse, TimelineItem } from '../src/shared/types'
import { GitService } from '../electron/main/git/git-service'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import { RuntimeManager } from '../electron/main/rpc/manager'
import type { RpcRuntime } from '../electron/main/rpc/runtime'
import { StateStore } from '../electron/main/store'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Git delivery & PR pure helpers', () => {
  it('parses SSH and HTTPS remotes while stripping credentials', () => {
    expect(parseRemoteRepoWebUrl('git@github.com:octo/agentui.git')).toEqual({
      host: 'github.com',
      ownerRepo: 'octo/agentui',
      baseWebUrl: 'https://github.com/octo/agentui',
      provider: 'github',
    })
    expect(parseRemoteRepoWebUrl('https://ghp_secret@github.com/octo/agentui.git')).toEqual({
      host: 'github.com',
      ownerRepo: 'octo/agentui',
      baseWebUrl: 'https://github.com/octo/agentui',
      provider: 'github',
    })
    expect(parseRemoteRepoWebUrl('ssh://git@gitlab.com:2222/team/sub/repo.git')).toEqual({
      host: 'gitlab.com',
      ownerRepo: 'team/sub/repo',
      baseWebUrl: 'https://gitlab.com/team/sub/repo',
      provider: 'gitlab',
    })
    expect(parseRemoteRepoWebUrl('not-a-url')).toBeNull()
  })

  it('builds GitHub and GitLab compare PR URLs and rejects detached HEAD', () => {
    const ghUrl = buildComparePrUrl('git@github.com:octo/agentui.git', 'feat/git-pr', {
      baseBranch: 'main',
      title: 'Add PR flow',
    })
    expect(ghUrl).toContain('https://github.com/octo/agentui/compare/main...feat/git-pr?')
    expect(ghUrl).toContain('expand=1')
    expect(ghUrl).toContain('title=Add+PR+flow')

    const glUrl = buildComparePrUrl('https://gitlab.com/team/repo.git', 'fix/bug', {
      baseBranch: 'main',
      title: 'Fix bug',
    })
    expect(glUrl).toContain('https://gitlab.com/team/repo/-/merge_requests/new?')
    expect(glUrl).toContain('merge_request%5Bsource_branch%5D=fix%2Fbug')

    expect(buildComparePrUrl('git@github.com:octo/agentui.git', 'HEAD (detached)')).toBeNull()
  })

  it('cleans AI commit output and synthesizes heuristic Conventional Commits', () => {
    expect(cleanGeneratedCommitMessage('```\nfeat(git): add push and PR workflow\n```\nExtra explanation')).toBe(
      'feat(git): add push and PR workflow',
    )
    expect(cleanGeneratedCommitMessage('提交信息： "fix(ui): align header badges."')).toBe(
      'fix(ui): align header badges',
    )
    expect(
      synthesizeHeuristicCommitMessage([{ status: 'M', path: 'docs/PLAN.md' }]),
    ).toBe('docs(docs): update PLAN.md')
    expect(
      synthesizeHeuristicCommitMessage([
        { status: 'A', path: 'tests/a.test.ts' },
        { status: 'A', path: 'tests/b.test.ts' },
      ]),
    ).toBe('test(tests): add a.test.ts and b.test.ts')
  })
})

describe('GitService push, PR fallback, and staged diff summary', () => {
  it('collects staged diff, detects remote/upstream state, passes --set-upstream on first push, and falls back to Compare URL when gh is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-git-push-'))
    tempDirs.push(dir)
    const work = join(dir, 'work')
    mkdirSync(work)

    execFileSync('git', ['init', '-b', 'feat/demo', work], { stdio: 'ignore' })
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Test User'])
    execFileSync('git', ['-C', work, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', work, 'remote', 'add', 'origin', 'git@github.com:octo/agentui.git'])

    writeFileSync(join(work, 'hello.ts'), 'export const x = 1\n', 'utf8')
    const git = new GitService()
    await git.stageFile(work, 'hello.ts')

    const staged = await git.getStagedDiffForCommit(work)
    expect(staged.files).toEqual([{ status: 'A', path: 'hello.ts' }])
    expect(staged.patch).toContain('+export const x = 1')

    await git.commit(work, 'feat: initial commit')
    const beforePush = await git.getStatus(work)
    expect(beforePush.branch).toBe('feat/demo')
    expect(beforePush.hasUpstream).toBe(false)
    expect(beforePush.remoteUrl).toBe('git@github.com:octo/agentui.git')

    // Intercept push execution so the test stays fast and works in restricted Windows sandboxes (where MSYS sh.exe cannot run)
    const gitCalls: string[][] = []
    const origExec = (git as unknown as { execGit: (...args: unknown[]) => Promise<string> }).execGit.bind(git)
    ;(git as unknown as { execGit: (c: string, args: string[], t?: number, env?: NodeJS.ProcessEnv) => Promise<string> }).execGit = async (
      c,
      args,
      t,
      env,
    ) => {
      if (args[0] === 'push') {
        gitCalls.push(args)
        return ''
      }
      return origExec(c, args, t, env)
    }

    const pushRes = await git.push(work)
    expect(pushRes).toEqual({ branch: 'feat/demo', remote: 'origin', setUpstream: true })
    expect(gitCalls).toEqual([['push', '--set-upstream', 'origin', 'feat/demo']])

    // Force gh unavailable and verify createPr pushes first and returns GitHub Compare URL
    ;(git as unknown as { resolveGh: () => string | null }).resolveGh = () => null
    const prRes = await git.createPr({ cwd: work, title: 'Demo PR', baseBranch: 'main' })
    expect(prRes.mode).toBe('compare-url')
    expect(prRes.url).toContain('https://github.com/octo/agentui/compare/main...feat/demo?')
    expect(prRes.url).toContain('title=Demo+PR')
    expect(gitCalls).toHaveLength(2)
  })
})

describe('Fine-grained allow/ask/deny permission rules & session memory', () => {
  it('derives safe command prefix patterns and rejects chained commands', () => {
    expect(deriveCommandPrefixPattern('npm test -- --run')).toBe('npm test*')
    expect(deriveCommandPrefixPattern('npm run build --mode prod')).toBe('npm run build*')
    expect(deriveCommandPrefixPattern('cargo check --workspace')).toBe('cargo check*')
    expect(deriveCommandPrefixPattern('pytest tests/test_api.py')).toBe('pytest*')
    expect(deriveCommandPrefixPattern('npm test && rm -rf /')).toBeNull()
    expect(deriveCommandPrefixPattern('npm test | sh')).toBeNull()
    expect(deriveCommandPrefixPattern('npm test\ntouch evil')).toBeNull()
  })

  it('enforces high-risk > deny > ask > allow > preset and blocks chained command allow bypass', () => {
    const rules = normalizePermissionRules([
      { id: 'r1', action: 'allow', target: 'command', pattern: 'npm test*', createdAt: 1 },
      { id: 'r2', action: 'allow', target: 'command', pattern: 'git push*', createdAt: 2 },
      { id: 'r3', action: 'deny', target: 'path', pattern: '.env*', createdAt: 3 },
      { id: 'r4', action: 'ask', target: 'command', pattern: 'npm test --update*', createdAt: 4 },
    ])

    // Allowed by prefix rule under approval preset
    const req1 = { title: 'Claude 请求执行 Bash', message: JSON.stringify({ command: 'npm test --run' }) }
    const m1 = matchPermissionRules(rules, req1)
    expect(m1?.id).toBe('r1')
    expect(decideApproval('approval', assessToolRequest(req1), m1).action).toBe('allow')

    // Word boundary guard: npm test* must NOT match npm testing-evil
    const reqBoundary = { title: 'Claude 请求执行 Bash', message: JSON.stringify({ command: 'npm testing-evil' }) }
    expect(matchPermissionRules(rules, reqBoundary)).toBeNull()

    // Shell chaining guard: allow rule must NOT allow chained command
    const reqChained = { title: 'Claude 请求执行 Bash', message: JSON.stringify({ command: 'npm test && touch pwn' }) }
    expect(matchPermissionRules(rules, reqChained)).toBeNull()

    // Ask beats Allow
    const reqAsk = { title: 'Claude 请求执行 Bash', message: JSON.stringify({ command: 'npm test --update' }) }
    const mAsk = matchPermissionRules(rules, reqAsk)
    expect(mAsk?.id).toBe('r4')
    expect(decideApproval('approval', assessToolRequest(reqAsk), mAsk).action).toBe('ask')

    // Deny rule on path blocks editing .env.local even in auto preset
    const reqEnv = { title: 'Claude 请求执行 Edit', message: JSON.stringify({ file_path: 'config/.env.local' }) }
    const mEnv = matchPermissionRules(rules, reqEnv)
    expect(mEnv?.id).toBe('r3')
    expect(decideApproval('auto', assessToolRequest(reqEnv), mEnv).action).toBe('deny')

    // High-risk invariant: allow rule `git push*` NEVER allows `git push origin main --force`
    const reqForce = { title: 'Claude 请求执行 Bash', message: JSON.stringify({ command: 'git push origin main --force' }) }
    const mForce = matchPermissionRules(rules, reqForce)
    expect(decideApproval('approval', assessToolRequest(reqForce), mForce).action).toBe('ask')

    // Readonly preset ceiling: write-level allow rule does not override readonly
    expect(decideApproval('readonly', assessToolRequest(req1), m1).action).toBe('deny')
  })

  it('applies per-thread session rules in RuntimeManager and attaches suggestedRule', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-sessrule-'))
    tempDirs.push(dir)
    const store = new StateStore(join(dir, 'state.json'))
    store.mutate((draft) => {
      draft.projects.push({
        id: 'p1',
        name: 'demo',
        path: dir,
        addedAt: Date.now(),
        defaultHarness: 'claude',
        trustPreset: 'approval',
        permissionRules: [],
      })
      draft.threads.push(
        {
          id: 't1',
          projectId: 'p1',
          title: 'T1',
          harness: 'claude',
          cwd: dir,
          thinkingLevel: 'medium',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'streaming',
        },
        {
          id: 't2',
          projectId: 'p1',
          title: 'T2',
          harness: 'claude',
          cwd: dir,
          thinkingLevel: 'medium',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'streaming',
        },
      )
    })

    const forwarded: ExtensionUiRequest[] = []
    const responses: ExtensionUiResponse[] = []
    const manager = new RuntimeManager(store, {} as unknown as HarnessDiscoveryService, {
      onThreadEvent: () => undefined,
      onThreadStatus: () => undefined,
      onExtensionUiRequest: (req) => forwarded.push(req),
    })

    const fakeRuntime = {
      respondExtensionUi: async (r: ExtensionUiResponse) => {
        responses.push(r)
      },
      stop: async () => undefined,
    } as unknown as RpcRuntime

    const dispatch = (threadId: string, id: string, cmd: string) => {
      ;(
        manager as unknown as {
          handleExtensionUiRequest: (tid: string, rt: RpcRuntime, req: ExtensionUiRequest) => void
        }
      ).handleExtensionUiRequest(threadId, fakeRuntime, {
        id,
        threadId,
        method: 'confirm',
        title: 'Claude 请求执行 Bash',
        message: JSON.stringify({ command: cmd }),
      })
    }

    // Before remembering: forwarded to human with suggestedRule
    dispatch('t1', 'u1', 'npm test --run')
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].suggestedRule).toEqual({ target: 'command', pattern: 'npm test*' })

    // Add session rule for t1
    const rules = manager.addSessionRule('t1', { action: 'allow', target: 'command', pattern: 'npm test*' })
    expect(rules).toHaveLength(1)

    // Next npm test on t1 is auto-allowed
    dispatch('t1', 'u2', 'npm test tests/a.test.ts')
    await new Promise((r) => setTimeout(r, 0))
    expect(responses).toEqual([{ id: 'u2', confirmed: true }])

    // Other thread t2 is NOT affected by t1's session rule
    dispatch('t2', 'u3', 'npm test')
    expect(forwarded).toHaveLength(2)
    expect(forwarded[1].id).toBe('u3')

    // Removing thread clears its session rules
    await manager.removeThread('t1')
    expect(manager.getSessionRules('t1')).toEqual([])
  })
})

describe('Unified Diff line parser & Composer comment formatter', () => {
  it('tracks accurate old/new line numbers across multiple files and formats review comments', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,3 +10,4 @@',
      ' const keep = 1',
      '-const oldVal = 2',
      '+const newVal = 3',
      '+const extra = 4',
      'diff --git a/src/removed.ts b/src/removed.ts',
      '--- a/src/removed.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line1',
      '-line2',
    ].join('\n')

    const parsed = parseUnifiedDiffLines(diff)
    const addLine = parsed.find((l) => l.raw === '+const newVal = 3')!
    expect(addLine.filePath).toBe('src/a.ts')
    expect(addLine.oldLine).toBeNull()
    expect(addLine.newLine).toBe(11)

    const extraLine = parsed.find((l) => l.raw === '+const extra = 4')!
    expect(extraLine.newLine).toBe(12)

    const sel = summarizeDiffSelection(parsed, parsed.indexOf(addLine), parsed.indexOf(extraLine))!
    expect(sel).toMatchObject({ filePath: 'src/a.ts', startLine: 11, endLine: 12, side: 'new' })
    const formatted = formatDiffCommentForComposer(sel, '请把变量名改清晰')
    expect(formatted).toContain('@src/a.ts#L11-L12 请把变量名改清晰')
    expect(formatted).toContain('```diff\n+const newVal = 3\n+const extra = 4\n```')

    // Deleted file lines fall back to old side and `--- a/...` path
    const del1 = parsed.find((l) => l.raw === '-line1')!
    expect(del1.filePath).toBe('src/removed.ts')
    expect(del1.oldLine).toBe(1)
    const delSel = summarizeDiffSelection(parsed, parsed.indexOf(del1), parsed.indexOf(del1))!
    expect(delSel.side).toBe('old')
    expect(formatDiffCommentForComposer(delSel, '不要删这行')).toContain('@src/removed.ts#L1（删除前原行号） 不要删这行')
  })
})

describe('Turn Navigator builder', () => {
  it('groups timeline items into turns with prompt previews, tool counts, errors, and diff stats', () => {
    const timeline: TimelineItem[] = [
      { id: 'u1', role: 'user', text: '第一轮：优化渲染\n第二行详情', timestamp: 100 },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'done' }],
        toolCalls: {
          c1: { id: 'c1', name: 'Read', argsText: '', status: 'success', output: '', isError: false },
          c2: { id: 'c2', name: 'Bash', argsText: '', status: 'error', output: 'fail', isError: true },
        },
        streaming: false,
        timestamp: 101,
      },
      { id: 'cs1', role: 'change-summary', changes: { files: 2, added: 15, removed: 4 }, timestamp: 102 },
      { id: 'u2', role: 'user', text: '第二轮：补充单测', timestamp: 200 },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], toolCalls: {}, streaming: false, timestamp: 201 },
    ]

    const turns = buildTurnNavEntries(timeline)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      turnNumber: 1,
      userItemId: 'u1',
      timelineIndex: 0,
      promptPreview: '第一轮：优化渲染',
      toolCount: 2,
      hasError: true,
      changes: { files: 2, added: 15, removed: 4 },
      summaryItemId: 'cs1',
    })
    expect(turns[1]).toMatchObject({
      turnNumber: 2,
      userItemId: 'u2',
      timelineIndex: 3,
      promptPreview: '第二轮：补充单测',
      toolCount: 0,
      hasError: false,
      changes: null,
    })
  })
})
