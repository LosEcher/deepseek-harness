import { describe, expect, it } from 'vitest'
import {
  canPairRoles,
  createBridgeId,
  encodeFrame,
  FrameDecoder,
  FrameError,
  HandshakeError,
  isPriorityFrame,
  parseBridgeMessage,
  PROTOCOL_VERSION,
  validatePeerHello,
} from '@deepseek-ai/dsh-bridge-protocol'
import type { BridgeMessage, Hello } from '@deepseek-ai/dsh-bridge-protocol'

function hello(role: Hello['role'], generation = 1, digest = 'sha256:contract'): Hello {
  return {
    bridge_version: PROTOCOL_VERSION,
    generation,
    role,
    build: 'test-build',
    schema_digest: digest,
    capabilities: ['call', 'agent-worker'],
  }
}

describe('BridgeId', () => {
  it('rejects an empty or whitespace identifier', () => {
    expect(() => createBridgeId('')).toThrow('bridge identifiers must not be empty')
    expect(() => createBridgeId('   ')).toThrow('bridge identifiers must not be empty')
    expect(createBridgeId('cmd-1')).toBe('cmd-1')
  })
})

describe('role pairing', () => {
  it('pairs node_root with rust_sidecar and node_worker', () => {
    expect(canPairRoles('node_root', 'rust_sidecar')).toBe(true)
    expect(canPairRoles('node_root', 'node_worker')).toBe(true)
    expect(canPairRoles('node_worker', 'node_root')).toBe(true)
    expect(canPairRoles('node_root', 'js_guest')).toBe(false)
    expect(canPairRoles('node_worker', 'rust_sidecar')).toBe(false)
  })
})

describe('handshake', () => {
  it('accepts a matching node_root and node_worker pair', () => {
    expect(() => validatePeerHello(
      hello('node_root'),
      hello('node_worker'),
      'sha256:contract',
      ['agent-worker'],
    )).not.toThrow()
  })

  it('rejects version, generation, role, digest, and capability failures', () => {
    const local = hello('node_root')
    expect(() => validatePeerHello(local, { ...hello('node_worker'), bridge_version: 2 }, 'sha256:contract'))
      .toThrow(HandshakeError)
    expect(() => validatePeerHello({ ...local, generation: 0 }, hello('node_worker'), 'sha256:contract'))
      .toThrow(/generation must be non-zero/)
    expect(() => validatePeerHello(local, hello('node_worker', 2), 'sha256:contract'))
      .toThrow(/generation mismatch/)
    expect(() => validatePeerHello(local, hello('js_guest'), 'sha256:contract'))
      .toThrow(/cannot pair/)
    expect(() => validatePeerHello(local, hello('node_worker', 1, 'sha256:other'), 'sha256:contract'))
      .toThrow(/digest mismatch/)
    expect(() => validatePeerHello(local, { ...hello('node_worker'), build: '  ' }, 'sha256:contract'))
      .toThrow(/build identifier is empty/)
    expect(() => validatePeerHello(local, { ...hello('node_worker'), capabilities: [''] }, 'sha256:contract'))
      .toThrow(/capability is empty/)
    expect(() => validatePeerHello(local, { ...hello('node_worker'), capabilities: ['call', 'call'] }, 'sha256:contract'))
      .toThrow(/duplicated/)
    expect(() => validatePeerHello(local, hello('node_worker'), 'sha256:contract', ['missing']))
      .toThrow(/required capability missing/)
  })
})

describe('framing', () => {
  it('round-trips a call across chunk boundaries', () => {
    const message: BridgeMessage = {
      kind: 'call',
      payload: { generation: 1, id: 'cmd-1', service: 'agent', method: 'followup', args: { text: 'hi' } },
    }
    const frame = encodeFrame(message)
    const decoder = new FrameDecoder()
    expect(decoder.push(frame.subarray(0, 8))).toEqual([])
    expect(decoder.push(frame.subarray(8))).toEqual([message])
    expect(decoder.bufferedLen).toBe(0)
  })

  it('rejects a missing Content-Length and an oversized header', () => {
    expect(() => new FrameDecoder().push(Buffer.from('X: 1\r\n\r\n{}', 'utf8'))).toThrow(FrameError)
    expect(() => new FrameDecoder().push(Buffer.alloc(4097, 0x41))).toThrow(/4096 byte limit/)
  })
})

describe('priority frames', () => {
  it('ranks cancel, fault, dispose, and error above ordinary traffic', () => {
    expect(isPriorityFrame({ kind: 'cancel', payload: { generation: 1, id: 'c' } })).toBe(true)
    expect(isPriorityFrame({
      kind: 'event_invoke',
      payload: { generation: 1, id: 'e', event: 'agent/fault', payload: {}, dispatch: 'emit' },
    })).toBe(true)
    expect(isPriorityFrame({ kind: 'dispose', payload: { generation: 1 } })).toBe(true)
    expect(isPriorityFrame({
      kind: 'call',
      payload: { generation: 1, id: 'c', service: 'agent', method: 'send', args: {} },
    })).toBe(false)
  })
})

describe('parseBridgeMessage', () => {
  it('rejects an unknown kind', () => {
    expect(() => parseBridgeMessage({ kind: 'nope', payload: {} })).toThrow(/kind is missing or unknown/)
  })
})
