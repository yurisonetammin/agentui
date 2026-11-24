import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { delimiter, join, resolve, win32 } from 'node:path'
import { shell } from 'electron'
import type { ExternalEditorId, ExternalEditorInfo } from '@shared/types'
import { isPathInside, isRealPathInside, prepareExecutableSpawn, safeChildEnvironment } from './process-utils'

function canExec(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK)
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function findInPath(names: readonly string[], extraCandidates: readonly string[]): string | null {
  const pathEnv = process.env.Path || process.env.PATH || ''
  const dirs = pathEnv
    .split(process.platform === 'win32' ? ';' : delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)

  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name)
      if (canExec(full)) return full
    }
  }
  for (const extra of extraCandidates) {
    if (extra && canExec(extra)) return extra
  }
  return null
}

function resolveEditorExecutable(id: 'vscode' | 'cursor'): string | null {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env.ProgramFiles || ''
    if (id === 'vscode') {
      return findInPath(['code.cmd', 'code.exe'], [
        local ? win32.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : '',
        pf ? win32.join(pf, 'Microsoft VS Code', 'bin', 'code.cmd') : '',
      ])
    }
    return findInPath(['cursor.cmd', 'cursor.exe'], [
      local ? win32.join(local, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd') : '',
      local ? win32.join(local, 'Programs', 'Cursor', 'resources', 'app', 'bin', 'cursor.cmd') : '',
    ])
  }
  if (id === 'vscode') {
    return findInPath(['code'], ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'])
  }
  return findInPath(['cursor'], ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'])
}

export function detectExternalEditors(): ExternalEditorInfo[] {
  const vscode = resolveEditorExecutable('vscode')
  const cursor = resolveEditorExecutable('cursor')
  return [
    { id: 'vscode', label: 'VS Code', available: Boolean(vscode), path: vscode },
    { id: 'cursor', label: 'Cursor', available: Boolean(cursor), path: cursor },
    {
      id: 'explorer',
      label: process.platform === 'win32' ? '资源管理器' : process.platform === 'darwin' ? 'Finder' : '文件管理器',
      available: true,
      path: null,
    },
  ]
}

export function openInExternalEditor(
  cwd: string,
  relPath: string,
  line?: number,
  preferred?: ExternalEditorId,
): { editor: ExternalEditorId; target: string } {
  if (!cwd) throw new Error('缺少工作区路径')
  const root = resolve(cwd)
  const cleanRel = relPath.trim()
  const abs = cleanRel ? resolve(root, cleanRel) : root
  if (!isPathInside(root, abs) || !isRealPathInside(root, abs)) {
    throw new Error('路径越界：仅允许打开工作区内的文件')
  }
  if (!existsSync(abs)) {
    throw new Error(`目标路径不存在: ${cleanRel || root}`)
  }

  const lineNum = typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null

  if (preferred === 'explorer') {
    shell.showItemInFolder(abs)
    return { editor: 'explorer', target: abs }
  }

  const order: Array<'vscode' | 'cursor'> =
    preferred === 'cursor'
      ? ['cursor', 'vscode']
      : preferred === 'vscode'
        ? ['vscode', 'cursor']
        : ['vscode', 'cursor']

  for (const id of order) {
    const exe = resolveEditorExecutable(id)
    if (!exe) {
      if (preferred === id) {
        throw new Error(`未在本机找到 ${id === 'vscode' ? 'VS Code' : 'Cursor'} CLI`)
      }
      continue
    }
    const targetArg = lineNum ? `${abs}:${lineNum}` : abs
    const spawnSpec = prepareExecutableSpawn(exe, ['-g', targetArg], safeChildEnvironment())
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      cwd: root,
      env: spawnSpec.env,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { editor: id, target: targetArg }
  }

  shell.showItemInFolder(abs)
  return { editor: 'explorer', target: abs }
}
