import { constants as fsConstants } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseHarnessVersion } from '../electron/main/discovery'
import { harnessChildEnvironment, prepareExecutableSpawn } from '../electron/main/process-utils'

describe('Windows shim resolution & version parsing', () => {
  it('parses version strings across Pi, OMP, and Prime formats', () => {
    expect(parseHarnessVersion('1.5.2\n')).toBe('1.5.2')
    expect(parseHarnessVersion('omp/18.18.9\n')).toBe('18.18.9')
    expect(parseHarnessVersion('0.10.3\n')).toBe('0.10.3')
    expect(parseHarnessVersion('2.1.325 (Claude Code)\n')).toBe('2.1.325')
  })

  it('resolves managed pi.cmd via install/current-version directly to node + cli.js', () => {
    const existing = new Set([
      'D:\\Tools\\Apps\\pi\\agent\\install\\current-version',
      'D:\\Tools\\Apps\\pi\\agent\\install\\releases\\1.5.2\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js',
      'D:\\node.exe',
    ])
    const files: Record<string, string> = {
      'D:\\Tools\\Apps\\pi\\agent\\install\\current-version': '1.5.2\n',
      'D:\\Tools\\Apps\\pi\\agent\\install\\releases\\1.5.2\\node_modules\\@earendil-works\\pi-coding-agent\\package.json':
        JSON.stringify({ bin: { pi: 'dist/bundle/cli.js' } }),
    }
    const inv = prepareExecutableSpawn(
      'D:\\Tools\\Apps\\pi\\agent\\bin\\pi.cmd',
      ['--mode', 'rpc'],
      { PATH: 'D:\\' },
      {
        platform: 'win32',
        canAccess: (p, _m) => existing.has(p) || p in files,
        readText: (p) => files[p],
      },
    )
    expect(inv.file).toBe('D:\\node.exe')
    expect(inv.args).toEqual([
      'D:\\Tools\\Apps\\pi\\agent\\install\\releases\\1.5.2\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js',
      '--mode',
      'rpc',
    ])
    expect(inv.env.PI_MANAGED_INSTALL_ROOT).toBe('D:\\Tools\\Apps\\pi\\agent\\install')
  })

  it('resolves prime-agent.cmd to ../share/prime-agent/prime-agent.exe', () => {
    const inv = prepareExecutableSpawn(
      'D:\\Tools\\Apps\\prime-agent\\bin\\prime-agent.cmd',
      ['--mode', 'rpc'],
      { USERPROFILE: 'C:\\Users\\Test' },
      {
        platform: 'win32',
        canAccess: (p, mode) =>
          p === 'D:\\Tools\\Apps\\prime-agent\\share\\prime-agent\\prime-agent.exe' && mode === fsConstants.X_OK,
      },
    )
    expect(inv.file).toBe('D:\\Tools\\Apps\\prime-agent\\share\\prime-agent\\prime-agent.exe')
    expect(inv.args).toEqual(['--mode', 'rpc'])
  })

  it('strips absolute PI_CONFIG_DIR and pins PI_CODING_AGENT_DIR for OMP', () => {
    const env = harnessChildEnvironment(
      'omp',
      'D:\\Tools\\Apps\\oh-my-pi\\agent',
      {},
      {
        PI_CONFIG_DIR: 'D:\\Tools\\Apps\\oh-my-pi\\config',
        PI_CODING_AGENT_DIR: 'D:\\Tools\\Apps\\pi\\agent',
      },
      'win32',
    )
    expect(env.PI_CONFIG_DIR).toBeUndefined()
    expect(env.PI_CODING_AGENT_DIR).toBe('D:\\Tools\\Apps\\oh-my-pi\\agent')
  })
})
