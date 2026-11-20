import type { AssistantPart, TimelineItem, TokenUsage, ToolCallItem } from './types'

type RpcRecord = Record<string, unknown>

function isRecord(value: unknown): value is RpcRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!isRecord(part)) return ''
      if (part.type === 'text' && typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractToolOutputText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!isRecord(result)) return ''
  const text = extractTextFromContent(result.content)
  if (text) return text
  if (typeof result.output === 'string') return result.output
  if (typeof result.error === 'string') return result.error
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return ''
  }
}

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const input = typeof raw.input === 'number' ? raw.input : 0
  const output = typeof raw.output === 'number' ? raw.output : 0
  const cacheRead = typeof raw.cacheRead === 'number' ? raw.cacheRead : 0
  const cacheWrite = typeof raw.cacheWrite === 'number' ? raw.cacheWrite : 0
  const totalTokens = typeof raw.totalTokens === 'number' ? raw.totalTokens : input + output + cacheRead + cacheWrite
  const costTotal = isRecord(raw.cost) && typeof raw.cost.total === 'number' ? raw.cost.total : undefined
  return { input, output, cacheRead, cacheWrite, totalTokens, costTotal }
}

function createStreamingAssistant(timestamp: number): Extract<TimelineItem, { role: 'assistant' }> {
  return {
    id: `ast-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    parts: [],
    toolCalls: {},
    streaming: true,
    timestamp,
  }
}

function ensureStreamingAssistant(items: TimelineItem[], now: number): {
  next: TimelineItem[]
  assistantIndex: number
} {
  const lastIndex = items.length - 1
  if (lastIndex >= 0 && items[lastIndex].role === 'assistant' && items[lastIndex].streaming) {
    return { next: [...items], assistantIndex: lastIndex }
  }
  const next = [...items, createStreamingAssistant(now)]
  return { next, assistantIndex: next.length - 1 }
}

function appendToLastPart(parts: AssistantPart[], type: 'text' | 'thinking', delta: string): AssistantPart[] {
  if (!delta) return parts
  const next = [...parts]
  const last = next[next.length - 1]
  if (last && last.type === type) {
    next[next.length - 1] = { type, text: last.text + delta }
    return next
  }
  next.push({ type, text: delta })
  return next
}

function upsertToolPart(
  assistant: Extract<TimelineItem, { role: 'assistant' }>,
  toolCallId: string,
  patch: Partial<ToolCallItem> & { name?: string },
): Extract<TimelineItem, { role: 'assistant' }> {
  const existing = assistant.toolCalls[toolCallId]
  const updatedTool: ToolCallItem = existing
    ? { ...existing, ...patch }
    : {
        id: toolCallId,
        name: patch.name ?? 'tool',
        argsText: patch.argsText ?? '',
        args: patch.args,
        status: patch.status ?? 'running',
        output: patch.output ?? '',
        isError: patch.isError ?? false,
        durationMs: patch.durationMs,
      }

  const hasToolPart = assistant.parts.some((p) => p.type === 'tool' && p.toolCallId === toolCallId)
  const parts = hasToolPart
    ? assistant.parts
    : [...assistant.parts, { type: 'tool' as const, toolCallId }]

  return {
    ...assistant,
    parts,
    toolCalls: {
      ...assistant.toolCalls,
      [toolCallId]: updatedTool,
    },
  }
}

export function applyRpcEventToTimeline(
  items: TimelineItem[],
  event: RpcRecord,
  now = Date.now(),
): TimelineItem[] {
  const type = asString(event.type)
  if (!type) return items

  if (type === 'agent_start') {
    const { next } = ensureStreamingAssistant(items, now)
    return next
  }

  if (type === 'message_start') {
    const msg = isRecord(event.message) ? event.message : null
    const role = msg ? asString(msg.role) : undefined
    if (role === 'user') {
      const text = extractTextFromContent(msg?.content)
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.role === 'user' && last.text === text) {
        return items
      }
      // Avoid duplicating if the user message immediately preceded an open assistant placeholder
      const prevUser = items.length >= 2 ? items[items.length - 2] : undefined
      if (last?.role === 'assistant' && last.streaming && last.parts.length === 0 && prevUser?.role === 'user' && prevUser.text === text) {
        return items
      }
      return [
        ...items,
        {
          id: `usr-${now}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          text,
          timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : now,
        },
      ]
    }
    if (role === 'assistant') {
      const { next, assistantIndex } = ensureStreamingAssistant(items, now)
      const current = next[assistantIndex] as Extract<TimelineItem, { role: 'assistant' }>
      const model = asString(msg?.model)
      next[assistantIndex] = {
        ...current,
        model: model ?? current.model,
      }
      return next
    }
    return items
  }

  if (type === 'message_update') {
    const ame = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null
    if (!ame) return items
    const subType = asString(ame.type)
    if (!subType) return items

    const { next, assistantIndex } = ensureStreamingAssistant(items, now)
    let current = next[assistantIndex] as Extract<TimelineItem, { role: 'assistant' }>

    if (subType === 'text_delta') {
      const delta = asString(ame.delta) ?? ''
      current = { ...current, parts: appendToLastPart(current.parts, 'text', delta) }
    } else if (subType === 'thinking_delta') {
      const delta = asString(ame.delta) ?? ''
      current = { ...current, parts: appendToLastPart(current.parts, 'thinking', delta) }
    } else if (subType === 'toolcall_start') {
      const id = asString(ame.id) ?? `call-${asString(ame.contentIndex) ?? current.parts.length}`
      const name = asString(ame.toolName) ?? 'tool'
      current = upsertToolPart(current, id, { name, status: 'running' })
    } else if (subType === 'toolcall_delta') {
      const delta = asString(ame.delta) ?? ''
      const id = asString(ame.id)
      const targetId = id ?? [...Object.keys(current.toolCalls)].pop()
      if (targetId && current.toolCalls[targetId]) {
        const prev = current.toolCalls[targetId]
        current = upsertToolPart(current, targetId, { argsText: prev.argsText + delta })
      }
    } else if (subType === 'toolcall_end') {
      const tc = isRecord(ame.toolCall) ? ame.toolCall : null
      if (tc) {
        const id = asString(tc.id) ?? asString(ame.id) ?? `call-${current.parts.length}`
        const name = asString(tc.name) ?? 'tool'
        const args = isRecord(tc.arguments) ? tc.arguments : undefined
        const argsText = args ? JSON.stringify(args, null, 2) : ''
        current = upsertToolPart(current, id, { name, args, argsText })
      }
    }

    next[assistantIndex] = current
    return next
  }

  if (type === 'message_end') {
    const msg = isRecord(event.message) ? event.message : null
    if (!msg || asString(msg.role) !== 'assistant') return items
    const { next, assistantIndex } = ensureStreamingAssistant(items, now)
    let current = next[assistantIndex] as Extract<TimelineItem, { role: 'assistant' }>
    const stopReason = asString(msg.stopReason)
    const errorMessage = asString(msg.errorMessage)
    const usage = parseUsage(msg.usage)
    const model = asString(msg.model) ?? current.model

    // Reconcile if streaming deltas were sparse or omitted (e.g. non-streamed error message)
    if (current.parts.length === 0 && Array.isArray(msg.content)) {
      const rebuiltParts: AssistantPart[] = []
      let rebuiltTools = { ...current.toolCalls }
      for (const block of msg.content) {
        if (!isRecord(block)) continue
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          rebuiltParts.push({ type: 'thinking', text: block.thinking })
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          rebuiltParts.push({ type: 'text', text: block.text })
        } else if (block.type === 'toolCall' && typeof block.id === 'string') {
          const args = isRecord(block.arguments) ? block.arguments : undefined
          rebuiltTools = {
            ...rebuiltTools,
            [block.id]: {
              id: block.id,
              name: asString(block.name) ?? 'tool',
              args,
              argsText: args ? JSON.stringify(args, null, 2) : '',
              status: 'running',
              output: '',
              isError: false,
            },
          }
          rebuiltParts.push({ type: 'tool', toolCallId: block.id })
        }
      }
      current = { ...current, parts: rebuiltParts, toolCalls: rebuiltTools }
    }

    next[assistantIndex] = {
      ...current,
      stopReason: stopReason ?? current.stopReason,
      errorMessage: errorMessage ?? current.errorMessage,
      usage: usage ?? current.usage,
      model,
    }
    return next
  }

  if (type === 'tool_execution_start') {
    const id = asString(event.toolCallId) ?? `tool-${now}`
    const name = asString(event.toolName) ?? 'tool'
    const args = isRecord(event.args) ? event.args : undefined
    const argsText = args ? JSON.stringify(args, null, 2) : ''
    const { next, assistantIndex } = ensureStreamingAssistant(items, now)
    const current = next[assistantIndex] as Extract<TimelineItem, { role: 'assistant' }>
    next[assistantIndex] = upsertToolPart(current, id, {
      name,
      args,
      argsText,
      status: 'running',
    })
    return next
  }

  if (type === 'tool_execution_update') {
    const id = asString(event.toolCallId)
    if (!id) return items
    const partial = extractToolOutputText(event.partialResult)
    const { next, assistantIndex } = ensureStreamingAssistant(items, now)
    const current = next[assistantIndex] as Extract<TimelineItem, { role: 'assistant' }>
    next[assistantIndex] = upsertToolPart(current, id, {
      name: asString(event.toolName),
      output: partial,
      status: 'running',
    })
    return next
  }

  if (type === 'tool_execution_end') {
    const id = asString(event.toolCallId)
    if (!id) return items
    const isError = event.isError === true
    const output = extractToolOutputText(event.result)
    const durationMs = typeof event.durationMs === 'number' ? event.durationMs : undefined
    const { next, assistantIndex } = ensureStreamingAssistant(items, now)
    const current = next[assistantIndex] as Extract<TimelineItem, { role: 'assistant' }>
    next[assistantIndex] = upsertToolPart(current, id, {
      name: asString(event.toolName),
      output,
      isError,
      status: isError ? 'error' : 'success',
      durationMs,
    })
    return next
  }

  if (type === 'agent_end' || type === 'agent_settled' || type === 'runtime_exit') {
    const isUnexpectedExit = type === 'runtime_exit' && event.unexpected === true
    const next = [...items]
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const item = next[i]
      if (item.role === 'assistant' && item.streaming) {
        const finalizedTools: Record<string, ToolCallItem> = {}
        for (const [key, tool] of Object.entries(item.toolCalls)) {
          if (tool.status === 'running') {
            finalizedTools[key] = isUnexpectedExit
              ? { ...tool, status: 'error', isError: true }
              : { ...tool, status: 'success' }
          } else {
            finalizedTools[key] = tool
          }
        }
        // Drop completely empty assistant placeholder if runtime exited before any output
        if (item.parts.length === 0 && !item.errorMessage) {
          next.splice(i, 1)
        } else {
          next[i] = { ...item, streaming: false, toolCalls: finalizedTools }
        }
      }
    }
    if (isUnexpectedExit) {
      const reason = asString(event.reason)
      const detail = reason ? `（${reason}）` : ''
      const exitKind =
        event.wasStreaming === true || (typeof event.code === 'number' && event.code !== 0)
          ? 'error'
          : 'warning'
      next.push({
        id: `exit-${now}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'notice',
        kind: exitKind,
        text: `Agent 进程意外退出${detail}，可点击下方「重新连接」或「重试上一条指令」。`,
        timestamp: now,
      })
    }
    return next
  }

  if (type === 'compaction_start') {
    const reason = asString(event.reason) ?? 'auto'
    return [
      ...items,
      {
        id: `cmp-s-${now}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'notice',
        kind: 'compaction',
        text: `正在压缩上下文 (${reason})...`,
        timestamp: now,
      },
    ]
  }

  if (type === 'compaction_end') {
    if (event.errorMessage) {
      return [
        ...items,
        {
          id: `cmp-e-${now}-${Math.random().toString(36).slice(2, 7)}`,
          role: 'notice',
          kind: event.errorSeverity === 'warning' ? 'warning' : 'error',
          text: `上下文压缩提示: ${String(event.errorMessage)}`,
          timestamp: now,
        },
      ]
    }
    const result = isRecord(event.result) ? event.result : null
    const before = typeof result?.tokensBefore === 'number' ? result.tokensBefore : undefined
    const after = typeof result?.estimatedTokensAfter === 'number' ? result.estimatedTokensAfter : undefined
    const detail = before !== undefined && after !== undefined
      ? `上下文已压缩: ${before.toLocaleString()} → ~${after.toLocaleString()} tokens`
      : '上下文压缩完成'
    return [
      ...items,
      {
        id: `cmp-e-${now}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'notice',
        kind: 'compaction',
        text: detail,
        timestamp: now,
      },
    ]
  }

  if (type === 'error' || type === 'transport_error' || type === 'transport_limit') {
    const msg = asString(event.error) ?? asString(event.message) ?? 'Agent execution error'
    return [
      ...items,
      {
        id: `err-${now}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'notice',
        kind: type === 'transport_limit' ? 'warning' : 'error',
        text: msg,
        timestamp: now,
      },
    ]
  }

  if (type === 'extension_ui_request' && asString(event.method) === 'notify') {
    const notifyType = asString(event.notifyType)
    const kind = notifyType === 'error' ? 'error' : notifyType === 'warning' ? 'warning' : 'info'
    return [
      ...items,
      {
        id: `ntf-${now}-${Math.random().toString(36).slice(2, 7)}`,
        role: 'notice',
        kind,
        text: asString(event.message) ?? '',
        timestamp: now,
      },
    ]
  }

  return items
}
