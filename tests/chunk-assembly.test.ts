import { describe, expect, it } from 'vitest'
import { RpcChunkAssembler, type RpcObject } from '../electron/main/rpc/chunk-assembly'

describe('RpcChunkAssembler', () => {
  it('reassembles multi-part base64 chunks into a single delivered frame', () => {
    const delivered: unknown[] = []
    const emitted: RpcObject[] = []
    const assembler = new RpcChunkAssembler({
      agentName: 'OMP',
      deliver: (f) => delivered.push(f),
      emit: (e) => emitted.push(e),
      active: () => true,
    })

    const original = { type: 'message_end', message: { role: 'assistant', text: 'hello omp chunked world' } }
    const buf = Buffer.from(JSON.stringify(original), 'utf8')
    const mid = Math.floor(buf.length / 2)
    const p1 = buf.subarray(0, mid)
    const p2 = buf.subarray(mid)

    assembler.accept({
      type: 'rpc_chunk',
      chunkId: 'c1',
      index: 0,
      count: 2,
      data: p1.toString('base64'),
      byteLength: p1.length,
    })
    expect(delivered).toHaveLength(0)

    assembler.accept({
      type: 'rpc_chunk',
      chunkId: 'c1',
      index: 1,
      count: 2,
      data: p2.toString('base64'),
      byteLength: p2.length,
    })
    expect(emitted).toHaveLength(0)
    expect(delivered).toEqual([original])
  })

  it('rejects out-of-order chunks and emits transport_limit', () => {
    const delivered: unknown[] = []
    const emitted: RpcObject[] = []
    const assembler = new RpcChunkAssembler({
      agentName: 'OMP',
      deliver: (f) => delivered.push(f),
      emit: (e) => emitted.push(e),
      active: () => true,
    })

    assembler.accept({
      type: 'rpc_chunk',
      chunkId: 'bad',
      index: 1,
      count: 2,
      data: Buffer.from('ab').toString('base64'),
    })
    expect(delivered).toHaveLength(0)
    expect(emitted[0]).toMatchObject({ type: 'transport_limit', kind: 'chunk' })
  })
})
