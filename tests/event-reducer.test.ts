import { describe, expect, it } from 'vitest'
import { applyRpcEventToTimeline } from '../src/shared/event-reducer'
import type { TimelineItem } from '../src/shared/types'

describe('applyRpcEventToTimeline', () => {
  it('streams thinking, tool execution, and text into structured assistant parts', () => {
    let items: TimelineItem[] = [{ id: 'u1', role: 'user', text: 'Check git status', timestamp: 1 }]

    items = applyRpcEventToTimeline(items, { type: 'agent_start' }, 2)
    items = applyRpcEventToTimeline(items, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'Planning step' },
    }, 3)
    items = applyRpcEventToTimeline(items, {
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'bash',
      args: { command: 'git status' },
    }, 4)
    items = applyRpcEventToTimeline(items, {
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'clean' }] },
      isError: false,
      durationMs: 42,
    }, 5)
    items = applyRpcEventToTimeline(items, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Working tree is clean.' },
    }, 6)
    items = applyRpcEventToTimeline(items, {
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        stopReason: 'stop',
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
      },
    }, 7)
    items = applyRpcEventToTimeline(items, { type: 'agent_settled' }, 8)

    expect(items).toHaveLength(2)
    const assistant = items[1]
    expect(assistant.role).toBe('assistant')
    if (assistant.role === 'assistant') {
      expect(assistant.streaming).toBe(false)
      expect(assistant.parts).toEqual([
        { type: 'thinking', text: 'Planning step' },
        { type: 'tool', toolCallId: 'tc1' },
        { type: 'text', text: 'Working tree is clean.' },
      ])
      expect(assistant.toolCalls.tc1.status).toBe('success')
      expect(assistant.toolCalls.tc1.output).toBe('clean')
      expect(assistant.toolCalls.tc1.durationMs).toBe(42)
      expect(assistant.usage?.totalTokens).toBe(120)
    }
  })

  it('marks running tools as error and appends disconnect notice on unexpected runtime_exit', () => {
    let items: TimelineItem[] = [{ id: 'u1', role: 'user', text: 'Run build', timestamp: 1 }]
    items = applyRpcEventToTimeline(items, { type: 'agent_start' }, 2)
    items = applyRpcEventToTimeline(
      items,
      { type: 'tool_execution_start', toolCallId: 'tc-crash', toolName: 'bash', args: { command: 'npm run build' } },
      3,
    )
    items = applyRpcEventToTimeline(
      items,
      { type: 'runtime_exit', code: 1, signal: null, unexpected: true, wasStreaming: true, reason: '退出码 1：OOM' },
      4,
    )

    expect(items).toHaveLength(3)
    const assistant = items[1]
    expect(assistant.role).toBe('assistant')
    if (assistant.role === 'assistant') {
      expect(assistant.streaming).toBe(false)
      expect(assistant.toolCalls['tc-crash'].status).toBe('error')
      expect(assistant.toolCalls['tc-crash'].isError).toBe(true)
    }
    const notice = items[2]
    expect(notice.role).toBe('notice')
    if (notice.role === 'notice') {
      expect(notice.kind).toBe('error')
      expect(notice.text).toContain('意外退出')
      expect(notice.text).toContain('OOM')
    }
  })

  it('does not append disconnect notice on intentional runtime_exit', () => {
    let items: TimelineItem[] = [{ id: 'u1', role: 'user', text: 'Hi', timestamp: 1 }]
    items = applyRpcEventToTimeline(items, { type: 'agent_start' }, 2)
    items = applyRpcEventToTimeline(items, { type: 'runtime_exit', code: 0, signal: null, unexpected: false }, 3)
    expect(items).toHaveLength(1)
  })
})
