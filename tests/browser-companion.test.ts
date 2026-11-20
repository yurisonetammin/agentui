import { describe, expect, it } from 'vitest'
import {
  BrowserCompanionService,
  egoExecutableCandidates,
  isBrowserLikeMcp,
  parseMcpConfigFiles,
} from '../electron/main/browser-companion'
import { findRunnableCandidate } from '../electron/main/process-utils'

describe('isBrowserLikeMcp', () => {
  it('classifies browser-related servers by name, command, args or url', () => {
    expect(isBrowserLikeMcp({ name: 'playwright', command: 'npx' })).toBe(true)
    expect(isBrowserLikeMcp({ name: 'foo', command: 'npx', args: ['-y', '@playwright/mcp'] })).toBe(true)
    expect(isBrowserLikeMcp({ name: 'ego', command: 'ego-browser', args: ['mcp'] })).toBe(true)
    expect(isBrowserLikeMcp({ name: 'remote', url: 'http://localhost:3000/browsermcp' })).toBe(true)
    expect(isBrowserLikeMcp({ name: 'puppeteer-server', command: 'node' })).toBe(true)
    expect(isBrowserLikeMcp({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] })).toBe(false)
    expect(isBrowserLikeMcp({ name: 'postgres', url: 'http://db.local/mcp' })).toBe(false)
  })
})

describe('parseMcpConfigFiles', () => {
  it('parses Claude ~/.claude.json top-level and per-project servers', () => {
    const content = JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
      projects: {
        'E:\\repo': {
          mcpServers: {
            'browser-use': { command: 'uvx', args: ['browser-use', '--mcp'] },
          },
        },
      },
    })
    const servers = parseMcpConfigFiles([{ source: '~/.claude.json', kind: 'json', content }])
    expect(servers).toHaveLength(3)
    const playwright = servers.find((s) => s.name === 'playwright')
    expect(playwright?.browserLike).toBe(true)
    const github = servers.find((s) => s.name === 'github')
    expect(github?.browserLike).toBe(false)
    const browserUse = servers.find((s) => s.name === 'browser-use')
    expect(browserUse?.browserLike).toBe(true)
    expect(browserUse?.source).toContain('E:\\repo')
  })

  it('parses project .mcp.json and Gemini settings.json shapes', () => {
    const content = JSON.stringify({
      mcpServers: {
        chrome: { command: 'node', args: ['chrome-mcp.js'] },
        remote: { url: 'https://mcp.example.com/sse' },
        invalid: { note: 'no command or url' },
      },
    })
    const servers = parseMcpConfigFiles([{ source: '.mcp.json', kind: 'json', content }])
    expect(servers.map((s) => s.name).sort()).toEqual(['chrome', 'remote'])
    expect(servers.find((s) => s.name === 'remote')?.url).toBe('https://mcp.example.com/sse')
  })

  it('parses Codex config.toml [mcp_servers.*] sections', () => {
    const content = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      'args = ["-y", "@playwright/mcp@latest"]',
      '',
      '[mcp_servers.docs]',
      'command = "uvx"',
      'args = ["mcp-docs"]',
      '',
      '[mcp_servers."browser-mcp"]',
      'url = "http://127.0.0.1:8090/mcp"',
      '',
      '[other_section]',
      'command = "should-be-ignored"',
    ].join('\n')
    const servers = parseMcpConfigFiles([{ source: '~/.codex/config.toml', kind: 'toml', content }])
    expect(servers).toHaveLength(3)
    const pw = servers.find((s) => s.name === 'playwright')
    expect(pw?.command).toBe('npx')
    expect(pw?.args).toEqual(['-y', '@playwright/mcp@latest'])
    expect(pw?.browserLike).toBe(true)
    expect(servers.find((s) => s.name === 'docs')?.browserLike).toBe(false)
    expect(servers.find((s) => s.name === 'browser-mcp')?.browserLike).toBe(true)
  })

  it('skips malformed JSON and dedupes identical entries', () => {
    const good = JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } })
    const servers = parseMcpConfigFiles([
      { source: 'a.json', kind: 'json', content: '{broken' },
      { source: 'b.json', kind: 'json', content: good },
      { source: 'c.json', kind: 'json', content: good },
    ])
    expect(servers).toHaveLength(1)
    expect(servers[0].source).toBe('b.json')
  })
})

describe('egoExecutableCandidates', () => {
  it('includes PATH dirs and the managed active_version_dir on Windows', () => {
    const candidates = egoExecutableCandidates(
      { Path: 'C:\\Tools\\bin;C:\\Windows\\system32' },
      'win32',
      'C:\\Users\\me',
    )
    expect(candidates).toContain('C:\\Tools\\bin\\ego-browser.exe')
    expect(candidates).toContain('C:\\Users\\me\\.local\\share\\ego\\active_version_dir\\ego-browser.exe')
  })

  it('uses POSIX separators on non-Windows platforms', () => {
    const candidates = egoExecutableCandidates({ PATH: '/usr/local/bin' }, 'linux', '/home/me')
    expect(candidates).toContain('/usr/local/bin/ego-browser')
    expect(candidates).toContain('/home/me/.local/share/ego/active_version_dir/ego-browser')
  })
})

const liveEgoPath = findRunnableCandidate(egoExecutableCandidates())

describe.skipIf(!liveEgoPath)('BrowserCompanionService live detection', () => {
  it('detects the installed ego-browser CLI and its version', async () => {
    const service = new BrowserCompanionService()
    const status = await service.getStatus(true)
    expect(status.ego.available).toBe(true)
    expect(status.ego.path).toBeTruthy()
    expect(status.ego.version).toMatch(/^\d+\.\d+/)
    expect(Array.isArray(status.mcpServers)).toBe(true)
  }, 20_000)
})

const liveBrowserEnabled = process.env.AGENTUI_LIVE_BROWSER === '1' && Boolean(liveEgoPath)

describe.skipIf(!liveBrowserEnabled)('BrowserCompanionService live quick controls', () => {
  it('opens a URL in the workbench space, lists tabs and takes a screenshot', async () => {
    const service = new BrowserCompanionService()
    const opened = await service.openUrl('https://example.com')
    expect(opened.url).toContain('example.com')
    expect(opened.spaceId).toBeTypeOf('number')

    const tabs = await service.listTabs()
    expect(tabs.some((t) => t.url.includes('example.com'))).toBe(true)

    const spaces = await service.listSpaces()
    expect(spaces.some((s) => s.name === 'agentui-workbench')).toBe(true)

    const shot = await service.screenshot()
    expect(shot.mimeType).toBe('image/png')
    expect(shot.data.length).toBeGreaterThan(1000)
    expect(Buffer.from(shot.data, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG')
  }, 240_000)

  it('rejects non-http URLs before spawning anything', async () => {
    const service = new BrowserCompanionService()
    await expect(service.openUrl('file:///C:/Windows/win.ini')).rejects.toThrow('仅支持 http(s) URL')
    await expect(service.openUrl('javascript:alert(1)')).rejects.toThrow('仅支持 http(s) URL')
  })
})