import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  buildComparePrUrl,
  type GitPrCreateInput,
  type GitPrCreateResult,
  type GitPushResult,
  type LinkedPullRequest,
} from '@shared/git-pr'
import type { GitFileChange, GitStatusSummary, GitTurnChanges, GitWorktreeInfo } from '@shared/types'
import {
  gitNetworkEnvironment,
  isPathInside,
  resolveGhExecutable,
  resolveGitExecutable,
  restrictedGitEnvironment,
  runProcess,
} from '../process-utils'

export interface GitTurnCapture {
  finish: () => Promise<{ changes: GitTurnChanges; diff: string | null }>
  discard: () => Promise<void>
}

const LINKED_PR_CACHE_TTL_MS = 45_000

export class GitService {
  private readonly gitExe = resolveGitExecutable()
  private ghExeCache: { checkedAt: number; path: string | null } | null = null
  private readonly linkedPrCache = new Map<string, { checkedAt: number; pr: LinkedPullRequest | null }>()

  private resolveGh(refresh = false): string | null {
    if (!refresh && this.ghExeCache && Date.now() - this.ghExeCache.checkedAt < 60_000) {
      return this.ghExeCache.path
    }
    const found = resolveGhExecutable()
    this.ghExeCache = { checkedAt: Date.now(), path: found }
    return found
  }

  private async resolvePrimaryRemote(cwd: string): Promise<{ name: string; url: string } | null> {
    const originUrl = await this.execGit(cwd, ['remote', 'get-url', 'origin'], 3_000)
      .then((s) => s.trim())
      .catch(() => '')
    if (originUrl) return { name: 'origin', url: originUrl }
    const remotes = await this.execGit(cwd, ['remote'], 3_000)
      .then((s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
      .catch(() => [])
    if (remotes.length === 0) return null
    const first = remotes[0]
    const url = await this.execGit(cwd, ['remote', 'get-url', first], 3_000)
      .then((s) => s.trim())
      .catch(() => '')
    return url ? { name: first, url } : null
  }

  private async execGit(cwd: string, args: string[], timeoutMs = 15_000, env = restrictedGitEnvironment()): Promise<string> {
    const res = await runProcess(this.gitExe, args, {
      cwd,
      env,
      timeoutMs,
      maxBytes: 8 * 1024 * 1024,
      resolveHarnessShim: false,
    })
    if (res.timedOut) throw new Error(`git ${args[0]} 超时`)
    if (res.outputExceeded) throw new Error(`git ${args[0]} 输出超出限制`)
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || `git ${args[0]} failed (${res.code})`)
    }
    return res.stdout
  }

  async beginTurn(cwd: string): Promise<GitTurnCapture> {
    const [root, realObjects] = await Promise.all([
      this.execGit(cwd, ['rev-parse', '--show-toplevel'], 3_000),
      this.execGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], 3_000),
    ])
    const repoRoot = root.trim()
    const directory = await mkdtemp(join(tmpdir(), 'agentui-turn-'))
    const objects = join(directory, 'objects')
    const hooks = join(directory, 'hooks')
    const discard = () => rm(directory, { recursive: true, force: true })

    try {
      await Promise.all([mkdir(join(objects, 'info'), { recursive: true }), mkdir(hooks)])
      // Store the index and any new Git objects outside the repository.
      await writeFile(join(objects, 'info', 'alternates'), `${realObjects.trim()}\n`)
      const env = { ...restrictedGitEnvironment(), GIT_INDEX_FILE: join(directory, 'index'), GIT_OBJECT_DIRECTORY: objects }
      const configKeys = await this.execGit(repoRoot, ['config', '-z', '--name-only', '--list'], 3_000)
      const filterKeys = configKeys.split('\0').filter((key) => /^filter\..+\.(clean|process|required)$/i.test(key))
      const options = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false']
      // A preview should not invoke project-configured clean filters or hooks.
      for (const key of new Set(filterKeys)) {
        options.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`)
      }
      const run = (args: string[]) => this.execGit(repoRoot, [...options, ...args], 5_000, env)
      const head = await run(['rev-parse', '--verify', 'HEAD']).then((value) => value.trim()).catch(() => null)
      await run(head ? ['read-tree', head] : ['read-tree', '--empty'])
      async function snapshot() {
        await run(['--literal-pathspecs', 'add', '--all', '--', '.'])
        return (await run(['write-tree'])).trim()
      }
      const before = await snapshot()
      return {
        discard,
        async finish() {
          try {
            const after = await snapshot()
            if (before === after) return { changes: { files: 0, added: 0, removed: 0 }, diff: null }
            const flags = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames']
            const [numstat, patch] = await Promise.all([
              run([...flags, '--numstat', '-z', before, after]),
              run([...flags, '--patch', before, after]).catch(() => null),
            ])
            const preview = patch?.slice(0, 350_000).split('\n', 4_000).join('\n')
            const diff = preview && preview.length < (patch?.length ?? 0) ? `${preview}\n[其余差异已省略]` : preview ?? null
            return { changes: parseTurnNumstat(numstat), diff }
          } finally {
            await discard()
          }
        },
      }
    } catch (error) {
      await discard()
      throw error
    }
  }

  async getStatus(cwd: string): Promise<GitStatusSummary> {
    if (!cwd || !existsSync(cwd)) {
      return { isRepo: false, branch: null, ahead: 0, behind: 0, changes: [], worktrees: [], error: '目录不存在' }
    }
    try {
      const repoRoot = (await this.execGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
      const statusOut = await this.execGit(cwd, ['status', '--porcelain=v1', '-b', '-z', '-uall'])
      const { branch, ahead, behind, hasUpstream, changes } = parsePorcelainStatusZ(statusOut)
      const [worktreeOut, primaryRemote] = await Promise.all([
        this.execGit(cwd, ['worktree', 'list', '--porcelain']).catch(() => ''),
        this.resolvePrimaryRemote(cwd),
      ])
      const worktrees = parseWorktreeList(worktreeOut, repoRoot)
      return {
        isRepo: true,
        repoRoot,
        branch,
        ahead,
        behind,
        hasUpstream,
        remoteUrl: primaryRemote?.url ?? null,
        ghAvailable: Boolean(this.resolveGh()),
        changes,
        worktrees,
      }
    } catch (err) {
      return {
        isRepo: false,
        branch: null,
        ahead: 0,
        behind: 0,
        changes: [],
        worktrees: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async getDiff(cwd: string, filePath?: string, staged = false): Promise<string> {
    const args = ['diff']
    if (staged) args.push('--cached')
    args.push('--no-color')
    if (filePath) args.push('--', filePath)

    const diff = await this.execGit(cwd, args)
    if (diff.trim() || !filePath || staged) return diff

    // Untracked file preview
    const status = await this.getStatus(cwd)
    const match = status.changes.find((c) => c.path === filePath && c.untracked)
    if (!match) return ''
    const absPath = resolve(cwd, filePath)
    if (!isPathInside(cwd, absPath) || !existsSync(absPath)) return ''
    const st = statSync(absPath)
    if (st.size > 200 * 1024) return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,1 @@\n+[File too large to preview: ${st.size} bytes]`
    const buf = readFileSync(absPath)
    if (buf.includes(0)) return `--- /dev/null\n+++ b/${filePath}\nBinary file (${st.size} bytes)`
    const lines = buf.toString('utf8').split(/\r?\n/)
    const body = lines.map((l) => `+${l}`).join('\n')
    return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}`
  }

  async stageFile(cwd: string, filePath: string): Promise<void> {
    await this.execGit(cwd, ['add', '-A', '--', filePath])
  }

  async unstageFile(cwd: string, filePath: string): Promise<void> {
    await this.execGit(cwd, ['reset', 'HEAD', '--', filePath]).catch(async () => {
      await this.execGit(cwd, ['rm', '--cached', '--', filePath])
    })
  }

  async discardFile(cwd: string, filePath: string, untracked = false): Promise<void> {
    if (untracked) {
      await this.execGit(cwd, ['clean', '-f', '--', filePath])
    } else {
      await this.execGit(cwd, ['checkout', '--', filePath])
    }
  }

  async commit(cwd: string, message: string): Promise<void> {
    const trimmed = message.trim()
    if (!trimmed) throw new Error('提交信息不能为空')
    await this.execGit(cwd, ['commit', '-m', trimmed], 20_000, gitNetworkEnvironment())
  }

  /** Collect staged file list and bounded diff patch for AI / heuristic commit message generation. */
  async getStagedDiffForCommit(cwd: string): Promise<{
    files: Array<{ status: string; path: string }>
    patch: string
  }> {
    const [nameStatus, rawPatch] = await Promise.all([
      this.execGit(cwd, ['diff', '--cached', '--name-status']),
      this.execGit(cwd, ['diff', '--cached', '--no-color']),
    ])
    const files = nameStatus
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t')
        const status = parts[0] ?? 'M'
        const path = parts[parts.length - 1] ?? ''
        return { status, path }
      })
      .filter((f) => f.path)
    return {
      files,
      patch: rawPatch.slice(0, 12_000),
    }
  }

  async push(cwd: string): Promise<GitPushResult> {
    const status = await this.getStatus(cwd)
    if (!status.isRepo || !status.branch || status.branch.startsWith('HEAD')) {
      throw new Error('当前处于游离 HEAD 或非 Git 仓库，无法推送')
    }
    const remote = await this.resolvePrimaryRemote(cwd)
    if (!remote) {
      throw new Error('未配置 Git 远程仓库 (remote)，请先添加 origin')
    }
    const setUpstream = !status.hasUpstream
    const args = setUpstream ? ['push', '--set-upstream', remote.name, status.branch] : ['push']
    await this.execGit(cwd, args, 60_000, gitNetworkEnvironment())
    if (status.repoRoot) {
      this.linkedPrCache.delete(`${status.repoRoot}::${status.branch}`)
    }
    return { branch: status.branch, remote: remote.name, setUpstream }
  }

  async getLinkedPr(cwd: string, refresh = false): Promise<LinkedPullRequest | null> {
    const gh = this.resolveGh(refresh)
    if (!gh) return null
    const status = await this.getStatus(cwd)
    if (!status.isRepo || !status.repoRoot || !status.branch || status.branch.startsWith('HEAD')) {
      return null
    }
    const cacheKey = `${status.repoRoot}::${status.branch}`
    const cached = this.linkedPrCache.get(cacheKey)
    if (!refresh && cached && Date.now() - cached.checkedAt < LINKED_PR_CACHE_TTL_MS) {
      return cached.pr
    }
    const res = await runProcess(
      gh,
      ['pr', 'view', '--json', 'number,title,url,state,isDraft'],
      {
        cwd,
        env: gitNetworkEnvironment(),
        timeoutMs: 10_000,
        maxBytes: 1024 * 1024,
        resolveHarnessShim: false,
      },
    ).catch(() => null)
    let pr: LinkedPullRequest | null = null
    if (res && !res.timedOut && res.code === 0 && res.stdout.trim()) {
      try {
        const parsed = JSON.parse(res.stdout) as {
          number?: number
          title?: string
          url?: string
          state?: string
          isDraft?: boolean
        }
        if (typeof parsed.number === 'number' && typeof parsed.url === 'string') {
          const rawState = String(parsed.state ?? 'OPEN').toUpperCase()
          const state: LinkedPullRequest['state'] = parsed.isDraft
            ? 'DRAFT'
            : rawState === 'MERGED' || rawState === 'CLOSED'
              ? rawState
              : 'OPEN'
          pr = {
            number: parsed.number,
            title: typeof parsed.title === 'string' ? parsed.title : `PR #${parsed.number}`,
            url: parsed.url,
            state,
          }
        }
      } catch {
        pr = null
      }
    }
    this.linkedPrCache.set(cacheKey, { checkedAt: Date.now(), pr })
    return pr
  }

  async createPr(input: GitPrCreateInput): Promise<GitPrCreateResult> {
    const status = await this.getStatus(input.cwd)
    if (!status.isRepo || !status.branch || status.branch.startsWith('HEAD')) {
      throw new Error('当前处于游离 HEAD 或非 Git 仓库，无法创建 PR')
    }
    if (!status.remoteUrl) {
      throw new Error('未配置 Git 远程仓库，无法创建 PR')
    }

    // Ensure remote branch is up to date before creating PR
    if (!status.hasUpstream || status.ahead > 0) {
      await this.push(input.cwd)
    }

    const latestSubject = await this.execGit(input.cwd, ['log', '-1', '--pretty=%s'], 5_000)
      .then((s) => s.trim())
      .catch(() => '')
    const recentLog = await this.execGit(input.cwd, ['log', '-5', '--pretty=- %s'], 5_000)
      .then((s) => s.trim())
      .catch(() => '')

    const title = input.title?.trim() || latestSubject || status.branch
    const body = input.body?.trim() || recentLog || ''
    const baseBranch = input.baseBranch?.trim() || undefined

    const gh = this.resolveGh()
    if (gh) {
      const args = ['pr', 'create', '--title', title, '--body', body, '--head', status.branch]
      if (baseBranch) args.push('--base', baseBranch)
      if (input.draft) args.push('--draft')

      const res = await runProcess(gh, args, {
        cwd: input.cwd,
        env: gitNetworkEnvironment(),
        timeoutMs: 30_000,
        maxBytes: 1024 * 1024,
        resolveHarnessShim: false,
      })
      if (!res.timedOut && res.code === 0) {
        const urlMatch = `${res.stdout}\n${res.stderr}`.match(/https?:\/\/\S+/)
        const url = urlMatch?.[0] ?? ''
        const numMatch = url.match(/\/pull\/(\d+)/)
        if (status.repoRoot) {
          this.linkedPrCache.delete(`${status.repoRoot}::${status.branch}`)
        }
        return {
          mode: 'gh',
          url,
          number: numMatch ? Number(numMatch[1]) : undefined,
        }
      }
      // If gh failed (e.g. unauthenticated or non-GitHub remote like GitLab), fall back to Compare URL when possible
      const fallbackUrl = buildComparePrUrl(status.remoteUrl, status.branch, { baseBranch, title, body })
      if (fallbackUrl) {
        return {
          mode: 'compare-url',
          url: fallbackUrl,
          note: `gh 创建 PR 未成功（${(res.stderr || res.stdout).trim().slice(0, 120) || '未登录或非 GitHub 仓库'}），已改为打开浏览器对比页面`,
        }
      }
      throw new Error(res.stderr.trim() || res.stdout.trim() || `gh pr create 失败 (${res.code})`)
    }

    const compareUrl = buildComparePrUrl(status.remoteUrl, status.branch, { baseBranch, title, body })
    if (!compareUrl) {
      throw new Error('未检测到 gh CLI，且无法从当前远程地址生成 GitHub/GitLab 对比链接')
    }
    return {
      mode: 'compare-url',
      url: compareUrl,
      note: '本机未安装 gh CLI，已在浏览器打开创建 PR 页面',
    }
  }

  async createWorktree(repoPath: string, branchName: string, baseRef?: string): Promise<GitWorktreeInfo> {
    const cleanBranch = branchName.trim()
    if (!cleanBranch || /[\s~^:?*[\]\\]/.test(cleanBranch)) {
      throw new Error('分支名称不合法')
    }
    const repoRoot = (await this.execGit(repoPath, ['rev-parse', '--show-toplevel'])).trim()
    const slug = cleanBranch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt'
    const wtRoot = join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`)
    mkdirSync(wtRoot, { recursive: true })
    let targetPath = join(wtRoot, slug)
    if (existsSync(targetPath)) {
      targetPath = join(wtRoot, `${slug}-${Date.now().toString(36)}`)
    }

    let branchExists = false
    try {
      await this.execGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${cleanBranch}`])
      branchExists = true
    } catch {
      branchExists = false
    }

    if (branchExists) {
      await this.execGit(repoRoot, ['worktree', 'add', targetPath, cleanBranch])
    } else {
      const args = ['worktree', 'add', '-b', cleanBranch, targetPath]
      if (baseRef?.trim()) args.push(baseRef.trim())
      await this.execGit(repoRoot, args)
    }

    const status = await this.getStatus(targetPath)
    const found = status.worktrees.find((w) => resolve(w.path) === resolve(targetPath))
    return (
      found ?? {
        path: targetPath,
        head: '',
        branch: cleanBranch,
        isMain: false,
        isBare: false,
        detached: false,
      }
    )
  }

  async removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(worktreePath)
    await this.execGit(repoPath, args)
  }
}

function parseTurnNumstat(output: string): GitTurnChanges {
  const entries = output.split('\0')
  const summary = { files: 0, added: 0, removed: 0 }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index].match(/^(\d+|-)\t(\d+|-)\t/)
    if (!entry) continue
    summary.files += 1
    summary.added += Number(entry[1]) || 0
    summary.removed += Number(entry[2]) || 0
    // Renames have an empty name followed by two NUL-delimited paths.
    if (entries[index].length === entry[0].length) index += 2
  }
  return summary
}

export function parsePorcelainStatusZ(output: string): {
  branch: string | null
  ahead: number
  behind: number
  hasUpstream: boolean
  changes: GitFileChange[]
} {
  const tokens = output.split('\0').filter((t) => t.length > 0)
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  let hasUpstream = false
  const changes: GitFileChange[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.startsWith('## ')) {
      const header = token.slice(3)
      const [branchPart, trackingPart] = header.split('...')
      if (branchPart.startsWith('No commits yet on ')) {
        branch = branchPart.slice('No commits yet on '.length)
      } else if (branchPart.startsWith('HEAD (no branch)')) {
        branch = 'HEAD (detached)'
      } else {
        branch = branchPart
      }
      if (trackingPart) {
        hasUpstream = true
        const aheadMatch = trackingPart.match(/ahead (\d+)/)
        const behindMatch = trackingPart.match(/behind (\d+)/)
        if (aheadMatch) ahead = Number(aheadMatch[1])
        if (behindMatch) behind = Number(behindMatch[1])
      }
      continue
    }

    if (token.length < 4) continue
    const x = token[0]
    const y = token[1]
    const path = token.slice(3)
    let oldPath: string | undefined
    if (x === 'R' || x === 'C') {
      oldPath = tokens[i + 1]
      i += 1
    }
    const untracked = x === '?' && y === '?'
    if (!untracked && x !== ' ' && x !== '?') {
      changes.push({ path, oldPath, indexStatus: x, worktreeStatus: y, untracked: false, staged: true })
    }
    if (untracked || (y !== ' ' && y !== '?')) {
      changes.push({ path, oldPath, indexStatus: x, worktreeStatus: y, untracked, staged: false })
    }
  }
  return { branch, ahead, behind, hasUpstream, changes }
}

export function parseWorktreeList(output: string, repoRoot: string): GitWorktreeInfo[] {
  const blocks = output.trim().split(/\r?\n\r?\n/).filter(Boolean)
  const list: GitWorktreeInfo[] = []
  const mainNorm = resolve(repoRoot)

  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    let path = ''
    let head = ''
    let branch: string | null = null
    let isBare = false
    let detached = false
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim()
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim()
      else if (line === 'bare') isBare = true
      else if (line === 'detached') detached = true
    }
    if (path) {
      list.push({
        path,
        head,
        branch,
        isMain: resolve(path) === mainNorm,
        isBare,
        detached,
      })
    }
  }
  return list
}
