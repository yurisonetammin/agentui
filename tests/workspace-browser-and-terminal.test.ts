import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TerminalExitEvent, TerminalOutputEvent } from '../src/shared/types'
import { WorkspaceBrowserService } from '../electron/main/workspace-browser'
import { TerminalService } from '../electron/main/terminal-service'

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-ws-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'node_modules'))
  mkdirSync(join(dir, '.git'))
  mkdirSync(join(dir, '.workbuddy'))
  mkdirSync(join(dir, '.github'))
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const x = 1\n', 'utf8')
  writeFileSync(join(dir, 'README.md'), '# hi\n', 'utf8')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
  return dir
}

describe('WorkspaceBrowserService', () => {
  it('lists directories first and hides noise dirs including .workbuddy', () => {
    const dir = makeWorkspace()
    const svc = new WorkspaceBrowserService()
    const entries = svc.listDir(dir)
    const names = entries.map((e) => e.name)
    expect(names).toContain('src')
    expect(names).toContain('.github')
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('.workbuddy')
    const firstFileIdx = entries.findIndex((e) => !e.isDirectory)
    const lastDirIdx = entries.map((e) => e.isDirectory).lastIndexOf(true)
    expect(lastDirIdx).toBeLessThan(firstFileIdx)
  })

  it('lists nested directories with relative paths', () => {
    const dir = makeWorkspace()
    const svc = new WorkspaceBrowserService()
    const entries = svc.listDir(dir, 'src')
    expect(entries).toEqual([{ name: 'app.ts', path: 'src/app.ts', isDirectory: false, sizeBytes: expect.any(Number) }])
  })

  it('reads text files with language detection', () => {
    const dir = makeWorkspace()
    const svc = new WorkspaceBrowserService()
    const file = svc.readFile(dir, 'src/app.ts')
    expect(file).toMatchObject({ content: 'export const x = 1\n', binary: false, truncated: false, language: 'typescript' })
  })

  it('flags binary files without returning content', () => {
    const dir = makeWorkspace()
    const svc = new WorkspaceBrowserService()
    const file = svc.readFile(dir, 'blob.bin')
    expect(file.binary).toBe(true)
    expect(file.content).toBe('')
  })

  it('truncates files larger than 512KB', () => {
    const dir = makeWorkspace()
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(600 * 1024))
    const svc = new WorkspaceBrowserService()
    const file = svc.readFile(dir, 'big.txt')
    expect(file.truncated).toBe(true)
    expect(file.content.length).toBe(512 * 1024)
    expect(file.sizeBytes).toBe(600 * 1024)
  })

  it('rejects path traversal for both listing and reading', () => {
    const dir = makeWorkspace()
    const svc = new WorkspaceBrowserService()
    expect(() => svc.readFile(dir, '../outside.txt')).toThrow('路径越界')
    expect(() => svc.listDir(dir, '..')).toThrow('路径越界')
  })
})

describe('TerminalService', () => {
  function makeService() {
    const outputs: TerminalOutputEvent[] = []
    const exits: TerminalExitEvent[] = []
    const svc = new TerminalService({
      onOutput: (e) => outputs.push(e),
      onExit: (e) => exits.push(e),
    })
    return { svc, outputs, exits }
  }

  function waitForExit(exits: TerminalExitEvent[], runId: string, timeoutMs = 15_000): Promise<TerminalExitEvent> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        const found = exits.find((e) => e.runId === runId)
        if (found) return resolve(found)
        if (Date.now() - started > timeoutMs) return reject(new Error('等待命令退出超时'))
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  it('runs a command and captures stdout plus exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-term-'))
    const { svc, outputs, exits } = makeService()
    const runId = svc.start(dir, 'echo agentui-terminal-ok')
    const exit = await waitForExit(exits, runId)
    expect(exit.code).toBe(0)
    expect(exit.timedOut).toBe(false)
    const stdout = outputs.filter((e) => e.runId === runId && e.stream === 'stdout').map((e) => e.text).join('')
    expect(stdout).toContain('agentui-terminal-ok')
    expect(outputs.some((e) => e.stream === 'system' && e.text.includes('echo agentui-terminal-ok'))).toBe(true)
  })

  it('rejects empty commands and missing working directories', () => {
    const { svc } = makeService()
    expect(() => svc.start(process.cwd(), '   ')).toThrow('命令不能为空')
    expect(() => svc.start(join(tmpdir(), 'agentui-definitely-missing-dir'), 'echo x')).toThrow('工作目录不存在')
  })

  it('stop terminates a long-running command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-term-stop-'))
    const { svc, exits } = makeService()
    const command = process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30'
    const runId = svc.start(dir, command)
    await new Promise((r) => setTimeout(r, 300))
    await svc.stop(runId)
    const exit = await waitForExit(exits, runId)
    expect(exit.timedOut).toBe(false)
  })
})