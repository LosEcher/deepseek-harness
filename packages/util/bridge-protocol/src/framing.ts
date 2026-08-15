/**
 * LSP-compatible Content-Length framing for product-bridge JSON messages.
 * @module @deepseek-ai/dsh-bridge-protocol
 */

import { parseBridgeMessage } from './message.ts'
import type { BridgeMessage, FrameErrorCode } from './types.ts'
import { DEFAULT_MAX_FRAME_SIZE } from './types.ts'

const SEPARATOR = Buffer.from('\r\n\r\n')

/** Framing failure with a stable code. */
export class FrameError extends Error {
  override readonly name = 'FrameError'

  /**
   * @param code - stable framing failure class.
   * @param message - diagnostic retained as the Error message.
   */
  constructor(readonly code: FrameErrorCode, message: string) {
    super(message)
  }
}

/**
 * Encode one message using the LSP-compatible Content-Length carrier.
 * @param message - logical bridge message.
 * @returns the complete frame bytes.
 */
export function encodeFrame(message: BridgeMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
  return Buffer.concat([header, body])
}

/**
 * Incremental decoder that accepts arbitrary transport chunk boundaries.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0)

  /**
   * @param maxFrameSize - maximum admitted body size in bytes.
   */
  constructor(private readonly maxFrameSize: number = DEFAULT_MAX_FRAME_SIZE) {}

  /**
   * Add bytes and return every complete message currently available.
   * @param bytes - next transport chunk.
   * @returns complete messages decoded from the accumulated buffer.
   */
  push(bytes: Uint8Array): BridgeMessage[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.buffer, bytes])
    const messages: BridgeMessage[] = []
    for (;;) {
      const separator = this.buffer.indexOf(SEPARATOR)
      if (separator < 0) {
        if (this.buffer.length > 4096) throw new FrameError('header-too-large', 'frame header exceeds the 4096 byte limit')
        break
      }
      if (separator > 4096) throw new FrameError('header-too-large', 'frame header exceeds the 4096 byte limit')
      let header: string
      try {
        header = this.buffer.subarray(0, separator).toString('utf8')
      } catch {
        throw new FrameError('header-encoding', 'frame header is not valid UTF-8')
      }
      const contentLength = parseContentLength(header)
      if (contentLength > this.maxFrameSize) {
        throw new FrameError('too-large', `frame exceeds the ${this.maxFrameSize} byte limit`)
      }
      const bodyStart = separator + 4
      const frameEnd = bodyStart + contentLength
      if (this.buffer.length < frameEnd) break
      const body = this.buffer.subarray(bodyStart, frameEnd).toString('utf8')
      this.buffer = this.buffer.subarray(frameEnd)
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch (error) {
        throw new FrameError('json', `frame JSON is invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
      messages.push(parseBridgeMessage(parsed))
    }
    return messages
  }

  /**
   * Number of bytes waiting for a complete frame.
   * @returns the unread buffer length.
   */
  get bufferedLen(): number {
    return this.buffer.length
  }
}

function parseContentLength(header: string): number {
  let parsed: number | undefined
  for (const line of header.split('\r\n')) {
    const split = line.indexOf(':')
    if (split < 0) continue
    if (line.slice(0, split).toLowerCase() !== 'content-length') continue
    if (parsed !== undefined) throw new FrameError('duplicate-content-length', 'frame header contains more than one Content-Length')
    const value = Number.parseInt(line.slice(split + 1).trim(), 10)
    if (!Number.isInteger(value) || value < 0) {
      throw new FrameError('invalid-content-length', 'frame Content-Length is invalid')
    }
    parsed = value
  }
  if (parsed === undefined) throw new FrameError('missing-content-length', 'frame header is missing Content-Length')
  return parsed
}
