import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fuzzyFilterPaths } from '@shared/composer-autocomplete'
import type { WorkspaceFileEntry } from '@shared/types'
import { resolveGitExecutable, restrictedGitEnvironment, runProcess } from './process-utils'

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
])

const CACHE_TTL_MS = 6_000
const MAX_FALLBACK_FILES = 3_000
const MAX_FALLBACK_DEPTH = 6

interface CachedFileList {
  files: string[]
  fetchedAt: number
}

function scanDirectoryFallback(root: string): string[] {
  const out: string[] = []

  function walk(absDir: string, relPrefix: string, depth: number): void {
    if (depth > MAX_FALLBACK_DEPTH || out.length >= MAX_FALLBACK_FILES) return
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FALLBACK_FILES) break
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        walk(join(absDir, entry.name), nextRel, depth + 1)
      } else if (entry.isFile()) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        out.push(rel)
      }
    }
  }

  walk(root, '', 0)
  return out
}

export class WorkspaceFileService {
  private readonly gitExe = resolveGitExecutable()
  private readonly cache = new Map<string, CachedFileList>()

  private async loadFileList(absCwd: string): Promise<string[]> {
    const cacheKey = process.platform === 'win32' ? absCwd.toLowerCase() : absCwd
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.files
    }

    let files: string[] | null = null
    try {
      const res = await runProcess(
        this.gitExe,
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        {
          cwd: absCwd,
          env: restrictedGitEnvironment(),
          timeoutMs: 4_000,
          maxBytes: 4 * 1024 * 1024,
          resolveHarnessShim: false,
        },
      )
      if (!res.timedOut && res.code === 0) {
        files = res.stdout
          .split('\0')
          .map((p) => p.replace(/\\/g, '/').trim())
          .filter(Boolean)
      }
    } catch {
      files = null
    }

    if (!files) {
      files = scanDirectoryFallback(absCwd)
    }

    this.cache.set(cacheKey, { files, fetchedAt: Date.now() })
    return files
  }

  async listFiles(cwd: string, query = '', limit = 40): Promise<WorkspaceFileEntry[]> {
    if (!cwd) return []
    const abs = resolve(cwd)
    if (!existsSync(abs)) return []
    try {
      if (!statSync(abs).isDirectory()) return []
    } catch {
      return []
    }

    const all = await this.loadFileList(abs)
    const matched = fuzzyFilterPaths(all, query, limit)
    return matched.map((relPath) => ({
      path: relPath,
      name: basename(relPath),
    }))
  }

  invalidate(cwd?: string): void {
    if (!cwd) {
      this.cache.clear()
      return
    }
    const abs = resolve(cwd)
    this.cache.delete(process.platform === 'win32' ? abs.toLowerCase() : abs)
  }
}
