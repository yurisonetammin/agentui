import { describe, expect, it } from 'vitest'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RUST_RPC_ADAPTER } from '../electron/main/rpc/adapters'

describe('Harness RPC adapters', () => {
  it('builds Pi start args without --cwd and uses --session', () => {
    const args = PI_RPC_ADAPTER.buildStartArgs({
      cwd: 'E:/repo',
      sessionPath: 'D:/sessions/s1.jsonl',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      thinkingLevel: 'high',
    })
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--session',
      'D:/sessions/s1.jsonl',
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4',
      '--thinking',
      'high',
    ])
  })

  it('builds OMP start args with --cwd, provider/model, and translates fork->branch', () => {
    const args = OMP_RPC_ADAPTER.buildStartArgs({
      cwd: 'E:/repo',
      sessionPath: 'D:/sessions/s2.jsonl',
      providerId: 'openai',
      modelId: 'gpt-5',
      thinkingLevel: 'medium',
    })
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--cwd',
      'E:/repo',
      '--resume',
      'D:/sessions/s2.jsonl',
      '--model',
      'openai/gpt-5',
      '--thinking',
      'medium',
    ])
    expect(OMP_RPC_ADAPTER.negotiateProtocolVersion).toBe(2)
    expect(OMP_RPC_ADAPTER.chunkedFrames).toBe(true)
    expect(OMP_RPC_ADAPTER.translateCommand({ type: 'fork', entryId: 'e1' })).toEqual({
      type: 'branch',
      entryId: 'e1',
    })
    expect(OMP_RPC_ADAPTER.normalizeEvent({ type: 'agent_end', isTerminal: false })).toBeNull()
    expect(OMP_RPC_ADAPTER.normalizeEvent({ type: 'auto_compaction_start', reason: 'threshold' })).toEqual({
      type: 'compaction_start',
      reason: 'threshold',
    })
  })

  it('synthesizes error event for Rust Prime failed assistant run', () => {
    const out = PRIME_RUST_RPC_ADAPTER.normalizeEvent({
      type: 'agent_end',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', stopReason: 'error', errorMessage: 'Missing API key' },
      ],
    })
    expect(Array.isArray(out)).toBe(true)
    expect(out).toHaveLength(2)
    expect((out as Array<Record<string, unknown>>)[1]).toMatchObject({
      type: 'error',
      error: 'Missing API key',
      synthetic: true,
    })
  })
})
