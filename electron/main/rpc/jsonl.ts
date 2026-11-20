import { StringDecoder } from 'node:string_decoder'

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * Decodes UTF-8 byte chunks into JSONL lines split strictly on LF (`0x0A`).
 * Unlike Node's `readline`, Unicode line/paragraph separators (U+2028, U+2029)
 * inside JSON strings are preserved intact.
 */
export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private pendingBytes = 0

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  ) {}

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (!text) return

    let start = 0
    while (start < text.length) {
      const nl = text.indexOf('\n', start)
      if (nl === -1) {
        const tail = text.slice(start)
        this.pendingBytes += Buffer.byteLength(tail, 'utf8')
        if (this.pendingBytes > this.maxFrameBytes) {
          this.pending = ''
          this.pendingBytes = 0
          throw new Error(`RPC frame exceeded ${this.maxFrameBytes} bytes`)
        }
        this.pending += tail
        break
      }

      const segment = text.slice(start, nl)
      const totalBytes = this.pendingBytes + Buffer.byteLength(segment, 'utf8')
      if (totalBytes > this.maxFrameBytes) {
        this.pending = ''
        this.pendingBytes = 0
        throw new Error(`RPC frame exceeded ${this.maxFrameBytes} bytes`)
      }

      let line = this.pending + segment
      this.pending = ''
      this.pendingBytes = 0
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0) this.onLine(line)
      start = nl + 1
    }
  }

  end(): void {
    const rem = this.decoder.end()
    const tail = (this.pending + rem).replace(/\r$/, '')
    this.pending = ''
    this.pendingBytes = 0
    if (tail.length > 0) this.onLine(tail)
  }
}
