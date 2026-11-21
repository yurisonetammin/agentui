import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMatchSnippet,
  extractSearchableSession,
  searchIndexedSessions,
  tokenizeSearchQuery,
  type IndexedSessionDoc,
} from '../src/shared/session-search'
import { HARNESS_IDS, type HarnessId, type HarnessStatus } from '../src/shared/types'
import type { HarnessDiscoveryService } from '../electron/main/discovery'
import { StateStore } from '../electron/main/store'
import { SessionSearchService } from '../electron/main/sessions/search-index'

function fakeDiscovery(roots: Partial<Record<HarnessId, string>>): HarnessDiscoveryService {
  const map = {} as Record<HarnessId, HarnessStatus>
  for (const id of HARNESS_IDS) {
    map[id] = {
      id,
      name: id,
      ready: Boolean(roots[id]),
      path: null,
      version: null,
      agentDir: '',
      sessionRoot: roots[id] ?? '',
    }
  }
  return { snapshot: () => map } as unknown as HarnessDiscoveryService
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('session-search pure functions', () => {
  it('extracts Pi-style jsonl metadata, session_info title, and messages', () => {
    const jsonl = [
      JSON.stringify({ type: 'session', id: 'sess-pi-1', cwd: 'E:/repo/demo' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '修复虚拟滚动抖动问题' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '检查 estimateSize' }, { type: 'text', text: '已在 App.tsx 中启用动态测高。' }] } }),
      JSON.stringify({ type: 'session_info', name: '虚拟滚动修复' }),
    ].join('\n')

    const extracted = extractSearchableSession(jsonl, 'fallback')
    expect(extracted.sessionId).toBe('sess-pi-1')
    expect(extracted.cwd).toBe('E:/repo/demo')
    expect(extracted.title).toBe('虚拟滚动修复')
    expect(extracted.messages).toHaveLength(2)
    expect(extracted.messages[0]).toEqual({ role: 'user', text: '修复虚拟滚动抖动问题' })
    expect(extracted.messages[1].text).toContain('estimateSize')
    expect(extracted.messages[1].text).toContain('App.tsx')
  })

  it('extracts Claude Code jsonl while skipping sidechain entries and XML hook titles', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', uuid: 'u0', sessionId: 'cl-42', cwd: '/proj', message: { role: 'user', content: '<system-hook>init</system-hook>' } }),
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'cl-42', cwd: '/proj', message: { role: 'user', content: '排查 OAuth2 回调 401 错误' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', isSidechain: true, sessionId: 'cl-42', message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain_secret_token' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', sessionId: 'cl-42', message: { role: 'assistant', content: [{ type: 'text', text: '原因是 redirect_uri 端口不匹配。' }] } }),
    ].join('\n')

    const extracted = extractSearchableSession(jsonl, 'fallback')
    expect(extracted.sessionId).toBe('cl-42')
    expect(extracted.cwd).toBe('/proj')
    expect(extracted.title).toBe('排查 OAuth2 回调 401 错误')
    expect(extracted.messages.some((m) => m.text.includes('sidechain_secret_token'))).toBe(false)
    expect(extracted.messages.some((m) => m.text.includes('redirect_uri'))).toBe(true)
  })

  it('tokenizes, ranks title/phrase hits higher, and centers snippets', () => {
    expect(tokenizeSearchQuery('  OAuth2   oauth2 端口 ')).toEqual(['oauth2', '端口'])

    const docs: IndexedSessionDoc[] = [
      {
        key: 'a',
        sessionPath: '/a.jsonl',
        sessionId: 'a',
        harness: 'pi',
        cwd: '/work',
        title: '杂项讨论',
        updatedAt: 200,
        threadId: null,
        projectId: null,
        projectName: null,
        messages: [{ role: 'assistant', text: '前文很长。'.repeat(30) + '这里提到 WebSocket 心跳超时重连。' + '后文很长。'.repeat(30) }],
      },
      {
        key: 'b',
        sessionPath: '/b.jsonl',
        sessionId: 'b',
        harness: 'claude',
        cwd: '/work',
        title: 'WebSocket 心跳超时排查',
        updatedAt: 100,
        threadId: 't-1',
        projectId: 'p-1',
        projectName: 'demo',
        messages: [{ role: 'user', text: 'WebSocket 心跳超时导致断线' }],
      },
    ]

    const hits = searchIndexedSessions(docs, 'websocket 心跳')
    expect(hits).toHaveLength(2)
    expect(hits[0].sessionId).toBe('b')
    expect(hits[1].snippet).toContain('WebSocket')
    expect(hits[1].snippet.startsWith('…')).toBe(true)

    const piOnly = searchIndexedSessions(docs, 'websocket', { harness: 'pi' })
    expect(piOnly.map((r) => r.sessionId)).toEqual(['a'])

    const snippet = buildMatchSnippet(`${'x'.repeat(120)} targetWord ${'y'.repeat(120)}`, ['targetword'], 60)
    expect(snippet).toContain('targetWord')
    expect(snippet.length).toBeLessThanOrEqual(64)
  })
})

describe('SessionSearchService incremental JSONL index', () => {
  it('indexes threads + CLI files, persists cache, updates on edit, and prunes deleted files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-fts-'))
    tempDirs.push(dir)
    const piRoot = join(dir, 'pi-sessions')
    const claudeRoot = join(dir, 'claude-sessions')
    mkdirSync(piRoot, { recursive: true })
    mkdirSync(claudeRoot, { recursive: true })

    const piFile = join(piRoot, 's1.jsonl')
    writeFileSync(
      piFile,
      [
        JSON.stringify({ type: 'session', id: 'pi-s1', cwd: join(dir, 'proj-a') }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '如何优化 Electron 启动速度' }] } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '延迟加载 highlight.js 语言包即可。' }] } }),
      ].join('\n'),
      'utf8',
    )

    const claudeFile = join(claudeRoot, 'c1.jsonl')
    writeFileSync(
      claudeFile,
      [
        JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'cl-s1', cwd: join(dir, 'proj-b'), message: { role: 'user', content: '配置 electron-builder NSIS 打包' } }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 'cl-s1', message: { role: 'assistant', content: [{ type: 'text', text: '在 electron-builder.yml 中设置 nsis 目标。' }] } }),
      ].join('\n'),
      'utf8',
    )

    const store = new StateStore(join(dir, 'state.json'))
    store.mutate((draft) => {
      draft.projects.push({
        id: 'p1',
        name: 'proj-a',
        path: join(dir, 'proj-a'),
        addedAt: Date.now(),
        defaultHarness: 'pi',
      })
      draft.threads.push({
        id: 't-mem',
        projectId: 'p1',
        title: '内存会话',
        harness: 'codex',
        cwd: join(dir, 'proj-a'),
        thinkingLevel: 'medium',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'idle',
      })
    })

    const discovery = fakeDiscovery({ pi: piRoot, claude: claudeRoot })
    const indexPath = join(dir, 'session-index.json')
    const service = new SessionSearchService({
      store,
      discovery,
      indexFilePath: indexPath,
      getCachedTimeline: (tid) =>
        tid === 't-mem'
          ? [{ id: 'm1', role: 'user', text: '检查 codex sandbox readOnly 策略', timestamp: Date.now() }]
          : undefined,
    })

    // Search CLI Pi file
    const r1 = service.search('highlight.js')
    expect(r1.indexedFiles).toBe(2)
    expect(r1.results).toHaveLength(1)
    expect(r1.results[0].harness).toBe('pi')
    expect(r1.results[0].projectId).toBe('p1')
    expect(r1.results[0].matchedRole).toBe('assistant')

    // Search CLI Claude file
    const r2 = service.search('NSIS 打包')
    expect(r2.results).toHaveLength(1)
    expect(r2.results[0].harness).toBe('claude')

    // Search live in-memory thread without a JSONL file
    const r3 = service.search('readOnly 策略')
    expect(r3.results).toHaveLength(1)
    expect(r3.results[0].threadId).toBe('t-mem')

    // Persist index and verify reload in a new instance
    service.flushToDisk()
    expect(existsSync(indexPath)).toBe(true)

    const reloaded = new SessionSearchService({ store, discovery, indexFilePath: indexPath })
    expect(reloaded.search('highlight.js').results).toHaveLength(1)

    // Modify piFile and confirm incremental re-index picks up new content
    writeFileSync(
      piFile,
      [
        JSON.stringify({ type: 'session', id: 'pi-s1', cwd: join(dir, 'proj-a') }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '新增关键字 zebra_token_99' }] } }),
      ].join('\n'),
      'utf8',
    )
    expect(reloaded.search('zebra_token_99').results).toHaveLength(1)

    // Delete claudeFile and confirm it's removed from search results
    unlinkSync(claudeFile)
    expect(reloaded.search('NSIS 打包').results).toHaveLength(0)
  })
})
