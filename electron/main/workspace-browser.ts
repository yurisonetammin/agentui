import { closeSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import type { WorkspaceDirEntry, WorkspaceFileContent } from '@shared/types'
import { isPathInside, isRealPathInside } from './process-utils'

const HIDDEN_DIRS = new Set([
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
  '.workbuddy',
])

const MAX_READ_BYTES = 512 * 1024
const MAX_WRITE_BYTES = 2 * 1024 * 1024
const MAX_DIR_ENTRIES = 2_000

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.vue': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.bat': 'dos',
  '.cmd': 'dos',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sql': 'sql',
  '.swift': 'swift',
  '.lua': 'lua',
  '.r': 'r',
  '.dockerfile': 'dockerfile',
  '.gitignore': 'bash',
  '.env': 'bash',
}

function detectLanguage(filePath: string): string | undefined {
  const name = filePath.toLowerCase()
  if (name.endsWith('dockerfile')) return 'dockerfile'
  if (name.endsWith('makefile')) return 'makefile'
  return LANGUAGE_BY_EXT[extname(name)]
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8_192))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

export class WorkspaceBrowserService {
  private resolveInside(cwd: string, relPath: string): string {
    const root = resolve(cwd)
    const abs = resolve(root, relPath)
    if (!isPathInside(root, abs) || !isRealPathInside(root, abs)) {
      throw new Error('路径越界：仅允许访问工作区内的文件')
    }
    return abs
  }

  listDir(cwd: string, relPath = ''): WorkspaceDirEntry[] {
    if (!cwd) return []
    const abs = this.resolveInside(cwd, relPath || '.')
    const st = statSync(abs)
    if (!st.isDirectory()) throw new Error(`不是目录: ${relPath}`)
    const entries = readdirSync(abs, { withFileTypes: true })
    const out: WorkspaceDirEntry[] = []
    for (const entry of entries) {
      if (out.length >= MAX_DIR_ENTRIES) break
      if (entry.isDirectory() && HIDDEN_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.github' && entry.isDirectory()) continue
      const rel = relPath ? `${relPath}/${entry.name}` : entry.name
      let sizeBytes: number | undefined
      if (entry.isFile()) {
        try {
          sizeBytes = statSync(join(abs, entry.name)).size
        } catch {
          sizeBytes = undefined
        }
      }
      out.push({ name: entry.name, path: rel, isDirectory: entry.isDirectory(), sizeBytes })
    }
    out.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return out
  }

  readFile(cwd: string, relPath: string): WorkspaceFileContent {
    if (!relPath) throw new Error('缺少文件路径')
    const abs = this.resolveInside(cwd, relPath)
    const st = statSync(abs)
    if (!st.isFile()) throw new Error(`不是文件: ${relPath}`)
    const sizeBytes = st.size
    const truncated = sizeBytes > MAX_READ_BYTES
    const fd = openSync(abs, 'r')
    let buf: Buffer
    try {
      const want = Math.min(sizeBytes, MAX_READ_BYTES)
      buf = Buffer.alloc(want)
      const got = readSync(fd, buf, 0, want, 0)
      buf = buf.subarray(0, got)
    } finally {
      closeSync(fd)
    }
    if (looksBinary(buf)) {
      return { path: relPath, content: '', sizeBytes, truncated: false, binary: true }
    }
    return {
      path: relPath,
      content: buf.toString('utf8'),
      sizeBytes,
      truncated,
      binary: false,
      language: detectLanguage(relPath),
    }
  }

  writeFile(cwd: string, relPath: string, content: string): { path: string; sizeBytes: number } {
    if (!cwd || !relPath) throw new Error('缺少文件路径')
    const abs = this.resolveInside(cwd, relPath)
    const st = statSync(abs)
    if (!st.isFile()) throw new Error(`只能保存已存在的普通文件: ${relPath}`)
    const buf = Buffer.from(content, 'utf8')
    if (buf.byteLength > MAX_WRITE_BYTES) {
      throw new Error(`文件内容超过保存上限（${Math.round(MAX_WRITE_BYTES / 1024 / 1024)} MB）`)
    }
    const tmp = join(dirname(abs), `.agentui-edit-${process.pid}-${Date.now()}.tmp`)
    try {
      writeFileSync(tmp, buf)
      renameSync(tmp, abs)
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
    return { path: relPath, sizeBytes: buf.byteLength }
  }
}