import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessId } from '../src/shared/types'
import {
  createForkedSessionFile,
  readClaudeSessionTimeline,
  readSessionForkTree,
  readSessionTimeline,
  scanCliSessions,
} from '../electron/main/sessions/catalog'

function writeClaudeSession(dir: string): string {
  const file = join(dir, 'sess-abc.jsonl')
  const entries = [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 'sess-abc',
      cwd: dir,
      isSidechain: false,
      timestamp: '2026-11-01T10:00:00.000Z',
      message: { role: 'user', content: '帮我修复登录 bug' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 'sess-abc',
      timestamp: '2026-11-01T10:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '先看代码' },
          { type: 'text', text: '我来读取文件' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'login.ts' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      sessionId: 'sess-abc',
      timestamp: '2026-11-01T10:00:06.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'export function login() {}' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'u2',
      sessionId: 'sess-abc',
      timestamp: '2026-11-01T10:00:10.000Z',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '已修复' }] },
    },
    // Sidechain branch must be excluded from the active chain.
    {
      type: 'assistant',
      uuid: 'side1',
      parentUuid: 'u1',
      sessionId: 'sess-abc',
      isSidechain: true,
      timestamp: '2026-11-01T10:00:07.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '子代理输出' }] },
    },
  ]
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8')
  return file
}

describe('Claude session catalog', () => {
  it('replays the uuid/parentUuid chain into a timeline with tool results attached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-claude-hist-'))
    const file = writeClaudeSession(dir)
    const items = readClaudeSessionTimeline(file)
    expect(items.map((i) => i.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(items[0]).toMatchObject({ role: 'user', text: '帮我修复登录 bug' })
    const first = items[1]
    if (first?.role !== 'assistant') throw new Error('expected assistant')
    expect(first.parts).toEqual([
      { type: 'thinking', text: '先看代码' },
      { type: 'text', text: '我来读取文件' },
      { type: 'tool', toolCallId: 'tu1' },
    ])
    expect(first.toolCalls.tu1).toMatchObject({
      name: 'Read',
      status: 'success',
      isError: false,
      output: 'export function login() {}',
    })
    expect(first.model).toBe('claude-sonnet-4-5')
    expect(first.timestamp).toBe(Date.parse('2026-11-01T10:00:05.000Z'))
    expect(items[2]).toMatchObject({ role: 'assistant' })
  })

  it('readSessionTimeline auto-detects Claude format via content sniffing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-claude-sniff-'))
    const file = writeClaudeSession(dir)
    const items = readSessionTimeline(file)
    expect(items.length).toBe(3)
    expect(items[0]?.role).toBe('user')
  })

  it('scanCliSessions extracts Claude session titles and cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-claude-scan-'))
    writeClaudeSession(dir)
    const summaries = scanCliSessions('claude', dir)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      harness: 'claude',
      sessionId: 'sess-abc',
      cwd: dir,
      title: '帮我修复登录 bug',
    })
  })

  it('bridged session paths return empty timelines and reject file-level forks', () => {
    for (const path of ['codex:th-1', 'acp:s-1', 'dsh:s-1']) {
      expect(readSessionTimeline(path)).toEqual([])
      expect(scanCliSessions(path.split(':')[0] as HarnessId, '/nonexistent')).toEqual([])
      const tree = readSessionForkTree(path)
      expect(tree.supportsNativeFork).toBe(false)
      expect(() => createForkedSessionFile(path)).toThrow('暂不支持文件级分叉')
    }
  })

  it('Claude sessions report no native fork support and reject forks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentui-claude-fork-'))
    const file = writeClaudeSession(dir)
    expect(readSessionForkTree(file).supportsNativeFork).toBe(false)
    expect(() => createForkedSessionFile(file)).toThrow('Claude Code')
  })
})