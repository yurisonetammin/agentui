import type { ContextUsageInfo, HarnessId, PrimeImplementation, ThinkingLevel } from '@shared/types'
import type { RpcObject } from './chunk-assembly'

export interface HarnessStartArgsInput {
  cwd: string
  sessionPath?: string | null
  providerId?: string | null
  modelId?: string | null
  thinkingLevel?: ThinkingLevel
}

export interface HarnessStateReading {
  contextUsage?: ContextUsageInfo
}

export interface HarnessRpcAdapter {
  readonly id: HarnessId
  readonly agentName: string
  readonly negotiateProtocolVersion?: number
  readonly chunkedFrames: boolean
  readonly implementation?: PrimeImplementation
  buildStartArgs(input: HarnessStartArgsInput): string[]
  translateCommand(command: RpcObject): RpcObject
  normalizeEvent(event: RpcObject): RpcObject | readonly RpcObject[] | null
  readState(data: RpcObject): HarnessStateReading
}

function isRecord(value: unknown): value is RpcObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unsafeArgValue(value: string): boolean {
  return value.startsWith('-') || /[\r\n]/.test(value)
}

export function parseContextUsage(raw: unknown): ContextUsageInfo | undefined {
  if (!isRecord(raw)) return undefined
  const contextWindow = typeof raw.contextWindow === 'number' && raw.contextWindow > 0 ? raw.contextWindow : undefined
  if (!contextWindow) return undefined
  const tokens = typeof raw.tokens === 'number' ? raw.tokens : null
  const percent = typeof raw.percent === 'number'
    ? raw.percent
    : tokens !== null
      ? Math.min(100, Math.round((tokens / contextWindow) * 1000) / 10)
      : null
  return { tokens, contextWindow, percent }
}

function extractRustPrimeAssistantError(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!isRecord(msg) || msg.role !== 'assistant') continue
    if (msg.stopReason === 'error') {
      if (typeof msg.errorMessage === 'string' && msg.errorMessage.trim()) return msg.errorMessage
      return 'Prime Agent run failed without an error detail'
    }
    return undefined
  }
  return undefined
}

export const PI_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'pi',
  agentName: 'Pi',
  chunkedFrames: false,
  buildStartArgs: (input) => {
    // Pi has no --cwd flag; working directory is applied via spawn cwd.
    const args = ['--mode', 'rpc']
    if (input.sessionPath) args.push('--session', input.sessionPath)
    if (input.modelId) {
      if (unsafeArgValue(input.modelId)) throw new TypeError('Invalid model id')
      if (input.providerId) args.push('--provider', input.providerId)
      args.push('--model', input.modelId)
    }
    if (input.thinkingLevel) args.push('--thinking', input.thinkingLevel)
    return args
  },
  translateCommand: (command) => {
    if (command.type === 'prompt' && command.streamingBehavior !== undefined) {
      return command
    }
    return command
  },
  normalizeEvent: (event) => event,
  readState: (data) => {
    const contextUsage = parseContextUsage(data.contextUsage)
    return contextUsage ? { contextUsage } : {}
  },
}

export const OMP_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'omp',
  agentName: 'OMP',
  negotiateProtocolVersion: 2,
  chunkedFrames: true,
  buildStartArgs: (input) => {
    const args = ['--mode', 'rpc', '--cwd', input.cwd]
    if (input.sessionPath) args.push('--resume', input.sessionPath)
    if (input.modelId) {
      const model = input.providerId ? `${input.providerId}/${input.modelId}` : input.modelId
      if (unsafeArgValue(model)) throw new TypeError('Invalid model id')
      args.push('--model', model)
    }
    if (input.thinkingLevel) args.push('--thinking', input.thinkingLevel)
    return args
  },
  translateCommand: (command) => {
    if (command.type === 'fork') return { ...command, type: 'branch' }
    if (command.type === 'get_fork_messages') return { ...command, type: 'get_branch_messages' }
    return command
  },
  normalizeEvent: (event) => {
    if (event.type === 'auto_compaction_start') {
      return { ...event, type: 'compaction_start' }
    }
    if (event.type === 'auto_compaction_end') {
      const end: RpcObject = { ...event, type: 'compaction_end' }
      if (event.skipped === true) return { ...end, errorSeverity: 'warning' }
      return end
    }
    // Non-terminal agent_end is an intermediate turn boundary inside a continuing OMP run.
    if (event.type === 'agent_end' && event.isTerminal === false) {
      return null
    }
    return event
  },
  readState: (data) => {
    const contextUsage = parseContextUsage(data.contextUsage)
    return contextUsage ? { contextUsage } : {}
  },
}

export const PRIME_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'prime',
  agentName: 'Prime Agent',
  chunkedFrames: false,
  implementation: 'typescript',
  buildStartArgs: (input) => {
    const args = ['--mode', 'rpc', '--cwd', input.cwd]
    if (input.sessionPath) args.push('--resume', input.sessionPath)
    if (input.modelId) {
      if (unsafeArgValue(input.modelId)) throw new TypeError('Invalid model id')
      if (input.providerId) args.push('--provider', input.providerId)
      args.push('--model', input.modelId)
    }
    if (input.thinkingLevel) args.push('--thinking', input.thinkingLevel)
    return args
  },
  translateCommand: (command) => command,
  normalizeEvent: (event) => event,
  readState: () => ({}),
}

export const PRIME_RUST_RPC_ADAPTER: HarnessRpcAdapter = {
  ...PRIME_RPC_ADAPTER,
  implementation: 'rust',
  normalizeEvent: (event) => {
    if (event.type === 'agent_end') {
      const err = extractRustPrimeAssistantError(event.messages)
      if (err) {
        return [event, { type: 'error', error: err, synthetic: true }]
      }
    }
    return event
  },
}

export function selectHarnessRpcAdapter(
  harness: HarnessId,
  primeImplementation?: PrimeImplementation,
): HarnessRpcAdapter {
  if (harness === 'pi') return PI_RPC_ADAPTER
  if (harness === 'omp') return OMP_RPC_ADAPTER
  return primeImplementation === 'typescript' ? PRIME_RPC_ADAPTER : PRIME_RUST_RPC_ADAPTER
}
