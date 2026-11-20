import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { TerminalExitEvent, TerminalOutputEvent } from '@shared/types'
import { killProcessTree, safeChildEnvironment } from './process-utils'

/**
 * Zero-native embedded command runner.
 *
 * AGENTS.md forbids node-gyp native deps (no MSVC/Rust toolchain on the target
 * machine), so this is NOT a PTY: each user command is executed via an explicit
 * shell process (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere) with
 * `shell: false` on the Node spawn itself. Interactive programs that require a
 * real TTY are out of scope; a prebuilt-PTY upgrade path is documented in PLAN.md.
 */

const MAX_CONCURRENT_RUNS = 4
const MAX_COMMAND_LENGTH = 8_192
const MAX_RUN_MS = 10 * 60_000

interface TerminalRun {
  child: ChildProcess
  cwd: string
  command: string
  startedAt: number
  timer: NodeJS.Timeout
  stopping: boolean
  timedOut: boolean
}

export interface TerminalServiceCallbacks {
  onOutput: (event: TerminalOutputEvent) => void
  onExit: (event: TerminalExitEvent) => void
}

export class TerminalService {
  private readonly runs = new Map<string, TerminalRun>()

  constructor(private readonly callbacks: TerminalServiceCallbacks) {}

  start(cwd: string, command: string): string {
    const trimmed = command.trim()
    if (!trimmed) throw new Error('命令不能为空')
    if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error('命令过长')
    const abs = resolve(cwd)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`工作目录不存在: ${abs}`)
    }
    if (this.runs.size >= MAX_CONCURRENT_RUNS) {
      throw new Error(`同时运行的命令已达上限 (${MAX_CONCURRENT_RUNS})，请先停止部分命令`)
    }

    const runId = randomUUID()
    const shellFile =
      process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const shellArgs =
      process.platform === 'win32' ? ['/d', '/s', '/c', trimmed] : ['-c', trimmed]

    this.callbacks.onOutput({ runId, stream: 'system', text: `$ ${trimmed}\n` })

    const child = spawn(shellFile, shellArgs, {
      cwd: abs,
      env: safeChildEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      const run = this.runs.get(runId)
      if (!run) return
      run.timedOut = true
      this.callbacks.onOutput({ runId, stream: 'system', text: '\n[命令超过 10 分钟，已自动终止]\n' })
      void this.stop(runId)
    }, MAX_RUN_MS)
    timer.unref()

    const run: TerminalRun = { child, cwd: abs, command: trimmed, startedAt: Date.now(), timer, stopping: false, timedOut: false }
    this.runs.set(runId, run)

    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk: Buffer) => {
      this.callbacks.onOutput({ runId, stream: 'stdout', text: outDecoder.write(chunk) })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.callbacks.onOutput({ runId, stream: 'stderr', text: errDecoder.write(chunk) })
    })
    child.once('error', (err) => {
      this.callbacks.onOutput({ runId, stream: 'system', text: `\n[启动失败: ${err.message}]\n` })
      this.finish(runId, null, null)
    })
    child.once('close', (code, signal) => {
      this.finish(runId, code, signal)
    })

    return runId
  }

  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || run.stopping) return
    run.stopping = true
    if (run.child.pid) {
      await killProcessTree(run.child.pid)
    } else {
      try {
        run.child.kill()
      } catch {
        // already gone
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.runs.keys()].map((id) => this.stop(id)))
  }

  private finish(runId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const run = this.runs.get(runId)
    if (!run) return
    this.runs.delete(runId)
    clearTimeout(run.timer)
    const exit: TerminalExitEvent = {
      runId,
      code,
      signal: signal ?? null,
      timedOut: run.timedOut,
    }
    this.callbacks.onExit(exit)
  }
}