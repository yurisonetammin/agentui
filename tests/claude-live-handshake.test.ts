import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_DESCRIPTORS,
  findRunnableCandidate,
  harnessChildEnvironment,
  harnessExecutableCandidates,
  killProcessTree,
  prepareExecutableSpawn,
} from '../electron/main/process-utils'
import { CLAUDE_RPC_ADAPTER } from '../electron/main/rpc/adapters'
import { StrictJsonlDecoder } from '../electron/main/rpc/jsonl'

// Live handshake against the locally installed Claude Code CLI.
// Waits for the first `system` frame carrying a session_id (SessionStart hook
// frames arrive before any user message; `system/init` itself only follows the
// first prompt). No prompt is sent, so no model tokens are consumed.
// Skipped when the CLI is not installed.
const claudePath = findRunnableCandidate(harnessExecutableCandidates(HARNESS_DESCRIPTORS.claude))

describe.skipIf(!claudePath)('Claude Code live stream-json handshake', () => {
  it(
    'emits system frames with a session id when spawned with the adapter args',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'agentui-claude-live-'))
      const desc = HARNESS_DESCRIPTORS.claude
      const args = CLAUDE_RPC_ADAPTER.buildStartArgs({ cwd, executablePath: claudePath! })
      const invocation = prepareExecutableSpawn(
        claudePath!,
        args,
        harnessChildEnvironment('claude', desc.agentDir(homedir(), process.env, claudePath!), {
          MAX_THINKING_TOKENS: '10240',
        }),
      )
      const child = spawn(invocation.file, invocation.args, {
        cwd,
        env: invocation.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      try {
        const init = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('等待 system 会话帧超时 (45s)')), 45_000)
          let stderr = ''
          const decoder = new StrictJsonlDecoder((line) => {
            try {
              const frame = JSON.parse(line) as Record<string, unknown>
              if (frame.type === 'system' && typeof frame.session_id === 'string' && frame.session_id) {
                clearTimeout(timer)
                resolve(frame)
              }
            } catch {
              // ignore malformed frames
            }
          })
          child.stdout?.on('data', (chunk: Buffer) => decoder.push(chunk))
          child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
          child.once('error', (err) => { clearTimeout(timer); reject(err) })
          child.once('close', (code) => {
            clearTimeout(timer)
            reject(new Error(`CLI 提前退出 (code ${code}): ${stderr.slice(-500)}`))
          })
        })
        expect(typeof init.session_id).toBe('string')
        expect(String(init.session_id).length).toBeGreaterThan(0)
      } finally {
        if (child.pid) await killProcessTree(child.pid)
      }
    },
    60_000,
  )
})