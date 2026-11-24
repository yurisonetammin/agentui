/**
 * Pure Git delivery & PR helpers:
 * - Remote URL parsing (SSH / HTTPS, strips embedded credentials)
 * - GitHub / GitLab compare PR URL generation (when `gh` CLI is absent)
 * - Heuristic Conventional Commits fallback & AI commit output sanitizer
 */

export interface LinkedPullRequest {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT'
}

export interface GitCommitSuggestion {
  message: string
  source: 'ai' | 'heuristic'
  note?: string
}

export interface GitPushResult {
  branch: string
  remote: string
  setUpstream: boolean
}

export interface GitPrCreateInput {
  cwd: string
  title?: string
  body?: string
  baseBranch?: string
  draft?: boolean
}

export interface GitPrCreateResult {
  mode: 'gh' | 'compare-url'
  url: string
  number?: number
  note?: string
}

export interface ParsedRemoteRepo {
  host: string
  ownerRepo: string
  baseWebUrl: string
  provider: 'github' | 'gitlab' | 'other'
}

function classifyProvider(host: string): 'github' | 'gitlab' | 'other' {
  const lower = host.toLowerCase()
  if (lower === 'github.com' || lower.endsWith('.github.com') || lower.includes('github')) return 'github'
  if (lower === 'gitlab.com' || lower.endsWith('.gitlab.com') || lower.includes('gitlab')) return 'gitlab'
  return 'other'
}

/**
 * Parse SSH or HTTP(S) git remote URLs into a clean web repository base URL.
 * Always strips any user/token credentials embedded in the remote URL.
 */
export function parseRemoteRepoWebUrl(remoteUrl: string | null | undefined): ParsedRemoteRepo | null {
  if (!remoteUrl) return null
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  let host = ''
  let repoPath = ''

  // SCP-like SSH: git@github.com:owner/repo.git
  const scpMatch = trimmed.match(/^(?:[^@\s]+@)?([A-Za-z0-9.-]+):(.+)$/)
  if (scpMatch && !trimmed.includes('://')) {
    host = scpMatch[1]
    repoPath = scpMatch[2]
  } else {
    try {
      const parsed = new URL(trimmed)
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
      host = parsed.hostname
      repoPath = parsed.pathname.replace(/^\/+/, '')
    } catch {
      return null
    }
  }

  repoPath = repoPath.replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!host || !repoPath || !repoPath.includes('/')) return null

  const scheme = trimmed.startsWith('http://') ? 'http' : 'https'
  return {
    host,
    ownerRepo: repoPath,
    baseWebUrl: `${scheme}://${host}/${repoPath}`,
    provider: classifyProvider(host),
  }
}

/** Build a browser-openable Create PR / Merge Request URL for GitHub or GitLab. */
export function buildComparePrUrl(
  remoteUrl: string | null | undefined,
  branch: string | null | undefined,
  options: { baseBranch?: string; title?: string; body?: string } = {},
): string | null {
  if (!branch || branch.startsWith('HEAD')) return null
  const repo = parseRemoteRepoWebUrl(remoteUrl)
  if (!repo) return null

  const cleanBranch = branch.trim()
  const base = options.baseBranch?.trim()
  const title = options.title?.trim()
  const body = options.body?.trim()

  if (repo.provider === 'github') {
    const encodedHead = cleanBranch.split('/').map(encodeURIComponent).join('/')
    const range = base
      ? `${base.split('/').map(encodeURIComponent).join('/')}...${encodedHead}`
      : encodedHead
    const params = new URLSearchParams({ expand: '1' })
    if (title) params.set('title', title)
    if (body) params.set('body', body.slice(0, 1_500))
    return `${repo.baseWebUrl}/compare/${range}?${params.toString()}`
  }

  if (repo.provider === 'gitlab') {
    const params = new URLSearchParams()
    params.set('merge_request[source_branch]', cleanBranch)
    if (base) params.set('merge_request[target_branch]', base)
    if (title) params.set('merge_request[title]', title)
    if (body) params.set('merge_request[description]', body.slice(0, 1_500))
    return `${repo.baseWebUrl}/-/merge_requests/new?${params.toString()}`
  }

  return null
}

/** Clean an LLM-produced commit message into a single-line Conventional Commit subject. */
export function cleanGeneratedCommitMessage(raw: string): string {
  const withoutFences = raw
    .replace(/^```[^\n]*\r?\n?/gm, '')
    .replace(/```\s*$/gm, '')
    .trim()
  const lines = withoutFences
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(commit message|提交信息|说明)[:：]?$/i.test(l))
  let subject = lines[0] ?? ''
  subject = subject
    .replace(/^(commit message|提交信息)[:：]\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.$/, '')
    .trim()
  if (subject.length > 100) subject = subject.slice(0, 100).trim()
  return subject
}

function inferScope(paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const buckets = new Set<string>()
  for (const p of paths) {
    const norm = p.replace(/\\/g, '/')
    if (norm.startsWith('src/renderer/')) buckets.add('ui')
    else if (norm.startsWith('src/shared/')) buckets.add('shared')
    else if (norm.startsWith('electron/main/git/')) buckets.add('git')
    else if (norm.startsWith('electron/main/rpc/')) buckets.add('rpc')
    else if (norm.startsWith('electron/main/')) buckets.add('main')
    else if (norm.startsWith('tests/')) buckets.add('tests')
    else if (norm.startsWith('docs/')) buckets.add('docs')
    else {
      const seg = norm.split('/')[0]
      if (seg && !seg.includes('.')) buckets.add(seg)
    }
  }
  if (buckets.size === 1) return [...buckets][0]
  return null
}

/** Deterministic Conventional Commits fallback when AI generation is unavailable. */
export function synthesizeHeuristicCommitMessage(
  stagedFiles: readonly { status: string; path: string }[],
): string {
  if (stagedFiles.length === 0) return 'chore: update workspace files'
  const paths = stagedFiles.map((f) => f.path.replace(/\\/g, '/'))
  const allDocs = paths.every((p) => p.endsWith('.md') || p.startsWith('docs/'))
  const allTests = paths.every((p) => p.startsWith('tests/') || /\.(test|spec)\.[a-z]+$/i.test(p))
  const allAdded = stagedFiles.every((f) => f.status.startsWith('A'))
  const allDeleted = stagedFiles.every((f) => f.status.startsWith('D'))

  const type = allDocs ? 'docs' : allTests ? 'test' : allAdded ? 'feat' : allDeleted ? 'chore' : 'feat'
  const scope = inferScope(paths)
  const verb = allAdded ? 'add' : allDeleted ? 'remove' : 'update'
  const names = paths.map((p) => p.split('/').pop() ?? p)
  const target =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} (+${names.length - 2} more)`

  return `${type}${scope ? `(${scope})` : ''}: ${verb} ${target}`
}
