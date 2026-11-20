import { describe, expect, it } from 'vitest'
import { StrictJsonlDecoder } from '../electron/main/rpc/jsonl'

describe('StrictJsonlDecoder', () => {
  it('decodes split UTF-8 chunks and strips optional CR', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((l) => lines.push(l))
    const payload = '{"text":"你好世界"}\r\n{"n":2}\n'
    const buf = Buffer.from(payload, 'utf8')
    // Split right inside a multi-byte UTF-8 character
    decoder.push(buf.subarray(0, 11))
    decoder.push(buf.subarray(11, 20))
    decoder.push(buf.subarray(20))
    decoder.end()
    expect(lines).toEqual(['{"text":"你好世界"}', '{"n":2}'])
  })

  it('preserves U+2028 and U+2029 inside JSON records without splitting', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((l) => lines.push(l))
    const raw = `{"text":"a\u2028b\u2029c"}\n`
    decoder.push(Buffer.from(raw, 'utf8'))
    decoder.end()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ text: 'a\u2028b\u2029c' })
  })

  it('throws when frame exceeds maxFrameBytes', () => {
    const decoder = new StrictJsonlDecoder(() => {}, 16)
    expect(() => decoder.push(Buffer.from('01234567890123456\n', 'utf8'))).toThrow(/exceeded/)
  })
})
