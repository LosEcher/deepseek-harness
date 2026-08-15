/**
 * Stdio Content-Length connection for one Agent worker generation.
 * @module @deepseek-ai/dsh-agent-worker
 */

import type { Readable, Writable } from 'node:stream'
import {
  encodeFrame,
  FrameDecoder,
  isPriorityFrame,
  type BridgeMessage,
} from '@deepseek-ai/dsh-bridge-protocol'
import { AgentControlError } from '@deepseek-ai/dsh-agent-control'

/** Full-duplex framed connection over a pair of byte streams. */
export class BridgeConnection {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }>()
  private nextId = 1
  private listeners: Array<(message: BridgeMessage) => void> = []

  /**
   * @param input - bytes from the peer.
   * @param output - bytes to the peer.
   * @param generation - live generation stamped on every outbound frame.
   */
  constructor(
    input: Readable,
    private readonly output: Writable,
    readonly generation: number,
  ) {
    input.on('data', (chunk: Buffer) => {
      const messages = this.decoder.push(chunk)
      const ordered = [
        ...messages.filter(isPriorityFrame),
        ...messages.filter(message => !isPriorityFrame(message)),
      ]
      for (const message of ordered) this.dispatch(message)
    })
  }

  /**
   * Send one already-built frame.
   * @param message - logical bridge message.
   */
  send(message: BridgeMessage): void {
    this.output.write(encodeFrame(message))
  }

  /**
   * Subscribe to inbound frames that are not call replies.
   * @param listener - observer invoked in generation-checked order.
   * @returns disposer.
   */
  onMessage(listener: (message: BridgeMessage) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(item => item !== listener)
    }
  }

  /**
   * Issue a call and wait for the matching reply or error.
   * @param service - bridge service name.
   * @param method - service method.
   * @param args - JSON-serializable arguments.
   * @returns the reply result.
   */
  call(service: string, method: string, args: unknown): Promise<unknown> {
    const id = `cmd-${this.nextId}`
    this.nextId += 1
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.send({
      kind: 'call',
      payload: { generation: this.generation, id, service, method, args },
    })
    return result
  }

  /**
   * Reject every outstanding call. Used when the child exits.
   * @param error - terminal connection failure.
   */
  failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private dispatch(message: BridgeMessage): void {
    if (message.kind === 'reply') {
      const pending = this.pending.get(message.payload.id)
      if (pending !== undefined) {
        this.pending.delete(message.payload.id)
        pending.resolve(message.payload.result)
      }
      return
    }
    if (message.kind === 'error') {
      const pending = this.pending.get(message.payload.id)
      if (pending !== undefined) {
        this.pending.delete(message.payload.id)
        pending.reject(new AgentControlError(
          message.payload.error.code as AgentControlError['code'],
          message.payload.error.message,
        ))
      }
      return
    }
    for (const listener of this.listeners) listener(message)
  }
}
