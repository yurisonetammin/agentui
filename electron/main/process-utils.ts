import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import type { HarnessId } from '@shared/types'

export interface HarnessDescriptor {
  id: HarnessId
  name: string
  binaryEnvVar: string
  executableNames: (platform: NodeJS.Platform) => readonly string[]
  candidateDirs: (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) => string[]
  agentDir: (home: string, env: NodeJS.ProcessEnv, executablePath?: string | null) => string
  sessionRoot: (home: string, env: NodeJS.ProcessEnv, executablePath?: string | null) => string
}

export const HARNESS_DESCRIPTORS: Record<HarnessId, HarnessDescriptor> = {
  pi: {
    id: 'pi',
    name: 'Pi',
    binaryEnvVar: 'PI_BINARY',
    executableNames: (platform) => (platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.ps1'] : ['pi']),
    candidateDirs: (platform, home, env) => {
      if (platform === 'win32') {
        return [
          env.PI_CODING_AGENT_DIR ? win32.join(env.PI_CODING_AGENT_DIR, 'bin') : '',
          win32.join(home, '.pi', 'agent', 'bin'),
        ].filter(Boolean)
      }
      return [
        join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'pi-node', 'current', 'bin'),
        join(home, '.pi', 'agent', 'bin'),
      ]
    },
    agentDir: (home, env) => env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'),
    sessionRoot: (home, env) => join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'sessions'),
  },
  omp: {
    id: 'omp',
    name: 'OMP',
    binaryEnvVar: 'OMP_BINARY',
    executableNames: (platform) => (platform === 'win32' ? ['omp.exe', 'omp.cmd'] : ['omp']),
    candidateDirs: (platform, home, env) => {
      if (platform === 'win32') {
        return [
          env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'omp') : '',
          env.PI_NATIVES_DIR ? win32.join(win32.dirname(env.PI_NATIVES_DIR), 'bin') : '',
        ].filter(Boolean)
      }
      return env.PI_INSTALL_DIR ? [env.PI_INSTALL_DIR] : [join(home, '.local', 'bin')]
    },
    agentDir: (home, env, executablePath) => {
      if (env.OMP_CODING_AGENT_DIR) return env.OMP_CODING_AGENT_DIR
      if (executablePath) {
        const sibling = join(dirname(dirname(executablePath)), 'agent')
        if (existsSync(sibling)) return sibling
      }
      return join(home, '.omp', 'agent')
    },
    sessionRoot: (home, env, executablePath) => {
      const dir = HARNESS_DESCRIPTORS.omp.agentDir(home, env, executablePath)
      return join(dir, 'sessions')
    },
  },
  prime: {
    id: 'prime',
    name: 'Prime Agent',
    binaryEnvVar: 'PRIME_AGENT_BINARY',
    executableNames: (platform) => (platform === 'win32' ? ['prime-agent.exe', 'prime-agent.cmd'] : ['prime-agent']),
    candidateDirs: (platform, home, env) => {
      if (platform === 'win32') {
        return [
          env.PRIME_AGENT_RUST_PREFIX ? win32.join(env.PRIME_AGENT_RUST_PREFIX, 'share', 'prime-agent') : '',
          env.PRIME_AGENT_CODING_AGENT_DIR ? win32.join(win32.dirname(env.PRIME_AGENT_CODING_AGENT_DIR), 'bin') : '',
          win32.join(home, '.local', 'share', 'prime-agent'),
        ].filter(Boolean)
      }
      return [
        join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'prime-agent-node', 'current', 'bin'),
        join(home, '.local', 'bin'),
      ]
    },
    agentDir: (home, env) => env.PRIME_AGENT_CODING_AGENT_DIR || join(home, '.prime', 'agent'),
    sessionRoot: (home, env) => join(env.PRIME_AGENT_CODING_AGENT_DIR || join(home, '.prime', 'agent'), 'sessions'),
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    binaryEnvVar: 'CLAUDE_BINARY',
    executableNames: (platform) => (platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']),
    candidateDirs: (platform, home, env) => {
      if (platform === 'win32') {
        return [
          env.CLAUDE_CODE_DIR ? win32.join(env.CLAUDE_CODE_DIR, 'bin') : '',
          win32.join(home, '.local', 'bin'),
        ].filter(Boolean)
      }
      return [join(home, '.local', 'bin'), join(home, '.claude', 'local')]
    },
    agentDir: (home) => join(home, '.claude'),
    sessionRoot: (home) => join(home, '.claude', 'projects'),
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    binaryEnvVar: 'CODEX_BINARY',
    executableNames: (platform) => (platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']),
    candidateDirs: (platform, home) => {
      if (platform === 'win32') return [win32.join(home, '.codex', 'bin')]
      return [join(home, '.codex', 'bin'), join(home, '.local', 'bin')]
    },
    agentDir: (home) => join(home, '.codex'),
    sessionRoot: (home) => join(home, '.codex', 'sessions'),
  },
  acp: {
    id: 'acp',
    name: 'ACP',
    binaryEnvVar: 'ACP_BINARY',
    executableNames: (platform) =>
      platform === 'win32'
        ? ['gemini.exe', 'gemini.cmd', 'qwen.exe', 'qwen.cmd', 'claude-code-acp.cmd', 'claude-code-acp.exe']
        : ['gemini', 'qwen', 'claude-code-acp'],
    candidateDirs: () => [],
    agentDir: (home) => join(home, '.acp'),
    sessionRoot: (home) => join(home, '.acp', 'sessions'),
  },
  dsh: {
    id: 'dsh',
    name: 'dsh',
    binaryEnvVar: 'DSH_BINARY',
    executableNames: (platform) => (platform === 'win32' ? ['dsh.exe', 'dsh.cmd'] : ['dsh']),
    candidateDirs: (platform, home, env) => {
      const dshHome = env.DSH_HOME || (platform === 'win32' ? win32.join(home, '.dsh') : join(home, '.dsh'))
      return [platform === 'win32' ? win32.join(dshHome, 'bin') : join(dshHome, 'bin')]
    },
    agentDir: (home, env) => env.DSH_HOME || join(home, '.dsh'),
    sessionRoot: (home, env) => join(env.DSH_HOME || join(home, '.dsh'), 'sessions'),
  },
}

export interface ProcessResult {
  code: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputExceeded: boolean
}

export interface ExecutableSpawnInvocation {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function isAbsoluteForPlatform(target: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!target) return false
  return platform === 'win32' ? win32.isAbsolute(target) && win32.parse(target).root !== '\\' : posix.isAbsolute(target)
}

function canAccessPath(candidate: string, mode: number): boolean {
  try {
    accessSync(candidate, mode)
    return true
  } catch {
    return false
  }
}

function uniquePaths(paths: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>()
  return paths.filter((p) => {
    if (!p) return false
    const key = platform === 'win32' ? p.toLowerCase() : p
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function safeChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of [
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_ENABLE_LOGGING',
    'ELECTRON_ENABLE_STACK_DUMPING',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'LD_PRELOAD',
    'FORCE_COLOR',
  ]) {
    delete env[key]
  }
  env.NO_COLOR = '1'
  return env
}

export function harnessChildEnvironment(
  harness: HarnessId,
  agentDir: string,
  extra: NodeJS.ProcessEnv = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = safeChildEnvironment({ ...baseEnv, ...extra })
  if (harness === 'omp') {
    // OMP treats PI_CONFIG_DIR as a folder relative to homedir(); an absolute
    // PI_CONFIG_DIR on Windows produces `C:\Users\...\D:\...` and crashes on mkdir.
    if (env.PI_CONFIG_DIR && isAbsoluteForPlatform(env.PI_CONFIG_DIR, platform)) {
      delete env.PI_CONFIG_DIR
    }
    if (agentDir) {
      env.PI_CODING_AGENT_DIR = agentDir
    }
  }
  return env
}

function sharedPackageManagerDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const fromRoot = (root: string | undefined, ...segments: string[]) => (root ? pathApi.join(root, ...segments) : '')
  const dirs = [
    env.NVM_BIN,
    env.BUN_INSTALL_BIN,
    fromRoot(env.NPM_CONFIG_PREFIX, 'bin'),
    fromRoot(env.BUN_INSTALL, 'bin'),
    fromRoot(env.VOLTA_HOME, 'bin'),
    env.PNPM_HOME,
    fromRoot(env.PNPM_HOME, 'bin'),
  ]
  if (platform === 'win32') {
    dirs.push(
      env.NPM_CONFIG_PREFIX,
      fromRoot(env.APPDATA, 'npm'),
      fromRoot(env.LOCALAPPDATA, 'pnpm'),
      fromRoot(env.LOCALAPPDATA, 'pnpm', 'bin'),
      fromRoot(env.LOCALAPPDATA, 'mise', 'shims'),
      win32.join(home, '.bun', 'bin'),
      win32.join(home, '.volta', 'bin'),
      win32.join(home, '.local', 'bin'),
    )
  } else {
    const dataHome = env.XDG_DATA_HOME && posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : posix.join(home, '.local', 'share')
    dirs.push(
      posix.join(home, '.local', 'bin'),
      posix.join(home, '.bun', 'bin'),
      posix.join(home, '.volta', 'bin'),
      posix.join(dataHome, 'pnpm'),
      posix.join(dataHome, 'pnpm', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
    )
  }
  return dirs.filter((d): d is string => Boolean(d && isAbsoluteForPlatform(d, platform)))
}

export function executableChildEnvironment(
  executable: string,
  env: NodeJS.ProcessEnv = safeChildEnvironment(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result = { ...env }
  if (!isAbsoluteForPlatform(executable, platform)) return result
  const pathApi = platform === 'win32' ? win32 : posix
  const pathKey = platform === 'win32' && result.Path !== undefined ? 'Path' : 'PATH'
  const sep = platform === 'win32' ? ';' : delimiter
  const home = (platform === 'win32' ? result.USERPROFILE : result.HOME) || homedir()
  const inherited = (result[pathKey] ?? '').split(sep)
  const merged = uniquePaths([pathApi.dirname(executable), ...inherited, ...sharedPackageManagerDirs(result, platform, home)], platform)
  result[pathKey] = merged.join(sep)
  return result
}

export function findNodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  extraDir?: string,
  canAccess: (p: string, mode: number) => boolean = canAccessPath,
): string | null {
  if (platform !== 'win32') return 'node'
  const pathEntries = [env.Path, env.PATH]
    .flatMap((v) => (v ?? '').split(';'))
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => isAbsoluteForPlatform(d, 'win32'))
  const candidates = uniquePaths(
    [
      extraDir ?? '',
      env.NVM_SYMLINK ?? '',
      env.NVM_HOME ?? '',
      ...pathEntries,
      env.ProgramFiles ? win32.join(env.ProgramFiles, 'nodejs') : '',
      env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs', 'nodejs') : '',
    ].filter(Boolean),
    'win32',
  )
  for (const dir of candidates) {
    const nodeExe = win32.join(dir, 'node.exe')
    if (canAccess(nodeExe, fsConstants.X_OK)) return nodeExe
  }
  return null
}

/**
 * Resolves managed Pi (`pi.cmd` / `pi.ps1` + `pi-launcher.js`), npm `.cmd` shims,
 * and `prime-agent.cmd` -> `..\share\prime-agent\prime-agent.exe` without cmd.exe.
 */
export function prepareExecutableSpawn(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = safeChildEnvironment(),
  options: {
    platform?: NodeJS.Platform
    canAccess?: (candidate: string, mode: number) => boolean
    readText?: (path: string) => string
  } = {},
): ExecutableSpawnInvocation {
  const platform = options.platform ?? process.platform
  const canAccess = options.canAccess ?? canAccessPath
  const readText = options.readText ?? ((p: string) => readFileSync(p, 'utf8'))
  const childEnv = executableChildEnvironment(file, env, platform)

  if (platform !== 'win32') {
    return { file, args: [...args], env: childEnv }
  }

  const base = win32.basename(file).toLowerCase()
  const binDir = win32.dirname(file)

  if (base === 'prime-agent.cmd' || base === 'prime-agent.ps1') {
    const rustExe = win32.resolve(binDir, '..', 'share', 'prime-agent', 'prime-agent.exe')
    if (canAccess(rustExe, fsConstants.X_OK)) {
      if (!childEnv.PRIME_AGENT_CODING_AGENT_DIR) {
        const home = childEnv.USERPROFILE || homedir()
        childEnv.PRIME_AGENT_CODING_AGENT_DIR = win32.join(home, '.prime', 'agent')
      }
      return { file: rustExe, args: [...args], env: childEnv }
    }
    const npmCli = win32.join(binDir, 'node_modules', 'prime-agent', 'dist', 'bundle', 'cli.js')
    if (canAccess(npmCli, fsConstants.F_OK)) {
      const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
      if (!nodeExe) throw new Error('Node.js was not found for prime-agent npm shim')
      return { file: nodeExe, args: [npmCli, ...args], env: childEnv }
    }
  }

  if (base === 'pi.cmd' || base === 'pi.ps1') {
    // 1. Official managed installer layout (`pi-launcher.js` + `../install/current-version`)
    const launcherJs = win32.join(binDir, 'pi-launcher.js')
    const installRoot = win32.resolve(binDir, '..', 'install')
    const currentVersionFile = win32.join(installRoot, 'current-version')
    if (canAccess(currentVersionFile, fsConstants.F_OK)) {
      try {
        const ver = readText(currentVersionFile).trim()
        const pkgDir = win32.join(installRoot, 'releases', ver, 'node_modules', '@earendil-works', 'pi-coding-agent')
        const pkgJson = JSON.parse(readText(win32.join(pkgDir, 'package.json'))) as { bin?: string | Record<string, string> }
        const relBin = typeof pkgJson.bin === 'string' ? pkgJson.bin : pkgJson.bin?.pi
        if (relBin) {
          const cliPath = win32.resolve(pkgDir, relBin)
          if (canAccess(cliPath, fsConstants.F_OK)) {
            const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
            if (!nodeExe) throw new Error('Node.js was not found for managed Pi installation')
            return {
              file: nodeExe,
              args: [cliPath, ...args],
              env: { ...childEnv, PI_MANAGED_INSTALL_ROOT: installRoot },
            }
          }
        }
      } catch {
        // Fallback to pi-launcher.js below
      }
    }
    if (canAccess(launcherJs, fsConstants.F_OK)) {
      const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
      if (!nodeExe) throw new Error('Node.js was not found for pi-launcher.js')
      return { file: nodeExe, args: [launcherJs, ...args], env: childEnv }
    }
    // 2. Standard npm global shim layout
    for (const rel of [
      ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'],
      ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'],
    ]) {
      const entry = win32.join(binDir, ...rel)
      if (canAccess(entry, fsConstants.F_OK)) {
        const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
        if (!nodeExe) throw new Error('Node.js was not found for Pi npm shim')
        return { file: nodeExe, args: [entry, ...args], env: childEnv }
      }
    }
  }

  if (base === 'omp.cmd') {
    for (const rel of [
      ['node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js'],
    ]) {
      const entry = win32.join(binDir, ...rel)
      if (canAccess(entry, fsConstants.F_OK)) {
        const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
        if (!nodeExe) throw new Error('Node.js was not found for OMP npm shim')
        return { file: nodeExe, args: [entry, ...args], env: childEnv }
      }
    }
  }

  if (base === 'claude.cmd') {
    const entry = win32.join(binDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    if (canAccess(entry, fsConstants.F_OK)) {
      const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
      if (!nodeExe) throw new Error('Node.js was not found for Claude Code npm shim')
      return { file: nodeExe, args: [entry, ...args], env: childEnv }
    }
  }

  if (base === 'codex.cmd') {
    for (const rel of [
      ['node_modules', '@openai', 'codex', 'bin', 'codex.js'],
      ['node_modules', '@openai', 'codex', 'dist', 'bin', 'codex.js'],
    ]) {
      const entry = win32.join(binDir, ...rel)
      if (canAccess(entry, fsConstants.F_OK)) {
        const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
        if (!nodeExe) throw new Error('Node.js was not found for Codex npm shim')
        return { file: nodeExe, args: [entry, ...args], env: childEnv }
      }
    }
  }

  // Generic npm `.cmd` shim fallback (gemini / qwen / dsh / claude-code-acp ...):
  // parse the `%~dp0...js` entry referenced by the shim and run it with node.exe.
  if (base.endsWith('.cmd')) {
    try {
      const shimText = readText(file)
      const match = shimText.match(/%~dp0\\?"?([^"\r\n]+?\.js)/i)
      if (match) {
        const relEntry = match[1].replace(/^[\\/]+/, '').replace(/\\/g, win32.sep)
        const entry = win32.resolve(binDir, relEntry)
        if (canAccess(entry, fsConstants.F_OK)) {
          const nodeExe = findNodeExecutable(childEnv, 'win32', binDir, canAccess)
          if (nodeExe) return { file: nodeExe, args: [entry, ...args], env: childEnv }
        }
      }
    } catch {
      // fall through to raw spawn
    }
  }

  return { file, args: [...args], env: childEnv }
}

export function harnessExecutableCandidates(
  descriptor: HarnessDescriptor,
  configuredPath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const candidates: string[] = []
  if (configuredPath && isAbsoluteForPlatform(configuredPath, platform)) {
    candidates.push(configuredPath)
  }
  const envOverride = env[descriptor.binaryEnvVar]
  if (envOverride && isAbsoluteForPlatform(envOverride, platform)) {
    candidates.push(envOverride)
  }
  const names = descriptor.executableNames(platform)
  const pathValues = platform === 'win32' ? [env.Path, env.PATH] : [env.PATH]
  const pathDirs = pathValues
    .flatMap((v) => (v ?? '').split(platform === 'win32' ? ';' : delimiter))
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => isAbsoluteForPlatform(d, platform))

  for (const dir of [...pathDirs, ...descriptor.candidateDirs(platform, home, env), ...sharedPackageManagerDirs(env, platform, home)]) {
    for (const name of names) {
      candidates.push(pathApi.join(dir, name))
    }
  }
  return uniquePaths(candidates, platform)
}

export function findRunnableCandidate(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile() && canAccessPath(candidate, fsConstants.F_OK)) {
        return candidate
      }
    } catch {
      // keep trying
    }
  }
  return null
}

export function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    maxBytes?: number
    resolveHarnessShim?: boolean
  } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const baseEnv = options.env ?? safeChildEnvironment()
  const invocation = options.resolveHarnessShim === false
    ? { file: executable, args: [...args], env: baseEnv }
    : prepareExecutableSpawn(executable, args, baseEnv)

  return new Promise((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(invocation.file, invocation.args, {
        cwd: options.cwd,
        env: invocation.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    child.stdin.end()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let outputExceeded = false
    let settled = false

    const finish = (code: number, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        outputExceeded,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) void killProcessTree(child.pid)
      else try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > maxBytes) {
        outputExceeded = true
        if (child.pid) void killProcessTree(child.pid)
        return
      }
      stdoutBytes += chunk.length
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes + chunk.length > maxBytes) {
        outputExceeded = true
        if (child.pid) void killProcessTree(child.pid)
        return
      }
      stderrBytes += chunk.length
      stderrChunks.push(chunk)
    })

    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.once('close', (code, signal) => {
      finish(code ?? (signal ? 1 : 0), signal)
    })
  })
}

export function killProcessTree(pid: number): Promise<void> {
  if (!pid || pid <= 0) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolveKill) => {
      let killer: ChildProcess
      try {
        killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        })
      } catch {
        resolveKill()
        return
      }
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveKill()
      }
      const timer = setTimeout(done, 4_000)
      timer.unref()
      killer.once('error', done)
      killer.once('close', done)
    })
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already dead */
    }
  }
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already dead */
        }
      }
      resolveWait()
    }, 1_000)
    timer.unref()
  })
}

export function resolveGitExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return 'git'
  for (const raw of [env.Path, env.PATH]) {
    for (const entry of (raw ?? '').split(';')) {
      const dir = entry.trim().replace(/^"(.*)"$/, '$1')
      if (!isAbsoluteForPlatform(dir, 'win32')) continue
      const candidate = win32.join(dir, 'git.exe')
      try {
        if (statSync(candidate).isFile()) return realpathSync(candidate)
      } catch {
        // continue
      }
    }
  }
  return 'git.exe'
}

/** Locate GitHub CLI (`gh`) without invoking a shell. Returns null if not installed. */
export function resolveGhExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === 'win32' ? ['gh.exe', 'gh.cmd'] : ['gh']
  const pathEntries = (process.platform === 'win32' ? [env.Path, env.PATH] : [env.PATH])
    .flatMap((raw) => (raw ?? '').split(process.platform === 'win32' ? ';' : ':'))
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => isAbsoluteForPlatform(dir, process.platform))
  const extraDirs =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\GitHub CLI',
          'C:\\Program Files (x86)\\GitHub CLI',
          ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI')] : []),
        ]
      : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']

  const pathApi = process.platform === 'win32' ? win32 : posix
  for (const dir of [...pathEntries, ...extraDirs]) {
    for (const name of names) {
      const candidate = pathApi.join(dir, name)
      try {
        if (statSync(candidate).isFile()) return realpathSync(candidate)
      } catch {
        // continue
      }
    }
  }
  return null
}

/**
 * Environment for Git network / PR commands (`git push`, `gh`) that need the
 * user's stored credentials/SSH config while remaining strictly non-interactive.
 */
export function gitNetworkEnvironment(): NodeJS.ProcessEnv {
  return safeChildEnvironment({
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
  })
}

export function restrictedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  }
  for (const key of process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']
    : ['PATH', 'TMPDIR', 'HOME', 'XDG_CONFIG_HOME']) {
    const val = process.env[key]
    if (val !== undefined) env[key] = val
  }
  return env
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = (process.platform === 'win32' ? win32 : posix).relative(resolve(parent), resolve(child))
  return rel === '' || (!/^\.\.([\\/]|$)/.test(rel) && !isAbsolute(rel))
}

/** Symlink-aware containment check: resolves real paths before comparing. */
export function isRealPathInside(parent: string, child: string): boolean {
  if (!isPathInside(parent, child)) return false
  try {
    return isPathInside(realpathSync(parent), realpathSync(child))
  } catch {
    return false
  }
}
