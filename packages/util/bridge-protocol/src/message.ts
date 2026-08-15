/**
 * Identifier, pairing, and JSON admission for product-bridge messages.
 * @module @deepseek-ai/dsh-bridge-protocol
 */

import type { BridgeId, BridgeMessage, BridgeRole, Hello, RemoteError } from './types.ts'
import { PROTOCOL_VERSION } from './types.ts'

const KINDS = new Set<BridgeMessage['kind']>([
  'hello',
  'call',
  'reply',
  'error',
  'cancel',
  'resource_open',
  'resource_release',
  'stream_open',
  'stream_chunk',
  'stream_credit',
  'stream_end',
  'contribution_register',
  'contribution_remove',
  'event_invoke',
  'continuation_call',
  'continuation_reply',
  'dispose',
  'quiescent',
])

const ROLES = new Set<BridgeRole>(['node_root', 'rust_sidecar', 'rust_root', 'js_guest', 'node_worker'])
const DISPATCH = new Set(['emit', 'serial', 'parallel', 'waterfall'])

/**
 * Reject an empty or whitespace-only bridge identifier.
 * @param value - candidate identifier.
 * @returns the admitted identifier.
 */
export function BridgeId(value: string): BridgeId {
  if (value.trim().length === 0) throw new Error('bridge identifiers must not be empty')
  return value
}

/**
 * Whether two roles are a supported root/guest pairing.
 * @param local - role of the validating process.
 * @param peer - role advertised by the peer Hello.
 * @returns true when the pairing is supported.
 */
export function canPairRoles(local: BridgeRole, peer: BridgeRole): boolean {
  return (
    (local === 'node_root' && peer === 'rust_sidecar')
    || (local === 'rust_sidecar' && peer === 'node_root')
    || (local === 'rust_root' && peer === 'js_guest')
    || (local === 'js_guest' && peer === 'rust_root')
    || (local === 'node_root' && peer === 'node_worker')
    || (local === 'node_worker' && peer === 'node_root')
  )
}

/** Handshake failure with a stable code. */
export class HandshakeError extends Error {
  override readonly name = 'HandshakeError'

  /**
   * @param code - stable handshake failure class.
   * @param message - diagnostic retained as the Error message.
   */
  constructor(readonly code: import('./types.ts').HandshakeErrorCode, message: string) {
    super(message)
  }
}

/**
 * Validate a peer Hello against local version, role, generation, and schema expectations.
 * @param local - Hello this process sent or will send.
 * @param peer - Hello received from the peer.
 * @param expectedSchemaDigest - digest this process requires.
 * @param requiredCapabilities - capabilities the peer must advertise.
 */
export function validatePeerHello(
  local: Hello,
  peer: Hello,
  expectedSchemaDigest: string,
  requiredCapabilities: readonly string[] = [],
): void {
  if (peer.bridge_version !== PROTOCOL_VERSION) {
    throw new HandshakeError('version', `unsupported bridge version ${peer.bridge_version}, expected ${PROTOCOL_VERSION}`)
  }
  if (local.generation === 0 || peer.generation === 0) {
    throw new HandshakeError('zero-generation', 'bridge generation must be non-zero')
  }
  if (local.generation !== peer.generation) {
    throw new HandshakeError('generation', `bridge generation mismatch: local ${local.generation}, peer ${peer.generation}`)
  }
  if (peer.build.trim().length === 0) {
    throw new HandshakeError('empty-build', 'bridge build identifier is empty')
  }
  if (!canPairRoles(local.role, peer.role)) {
    throw new HandshakeError('role', `bridge roles ${local.role} and ${peer.role} cannot pair`)
  }
  if (peer.schema_digest !== expectedSchemaDigest) {
    throw new HandshakeError('schema-digest', `bridge schema digest mismatch: local ${expectedSchemaDigest}, peer ${peer.schema_digest}`)
  }
  const seen = new Set<string>()
  for (const capability of peer.capabilities) {
    if (capability.trim().length === 0) {
      throw new HandshakeError('empty-capability', 'bridge capability is empty')
    }
    if (seen.has(capability)) {
      throw new HandshakeError('duplicate-capability', `bridge capability ${capability} is duplicated`)
    }
    seen.add(capability)
  }
  for (const required of requiredCapabilities) {
    if (!seen.has(required)) {
      throw new HandshakeError('missing-capability', `bridge peer does not support required capability ${required}`)
    }
  }
}

/**
 * Parse one JSON value as a bridge message. Structural admission only; generation
 * and service rules belong to the consuming service.
 * @param value - decoded JSON document.
 * @returns the admitted message.
 */
export function parseBridgeMessage(value: unknown): BridgeMessage {
  if (!isRecord(value) || typeof value.kind !== 'string' || !KINDS.has(value.kind as BridgeMessage['kind'])) {
    throw new Error('bridge message kind is missing or unknown')
  }
  if (!isRecord(value.payload)) throw new Error('bridge message payload must be an object')
  const kind = value.kind as BridgeMessage['kind']
  const payload = value.payload
  switch (kind) {
    case 'hello':
      return { kind, payload: parseHello(payload) }
    case 'call':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          service: requireString(payload, 'service'),
          method: requireString(payload, 'method'),
          args: payload.args,
        },
      }
    case 'reply':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          result: payload.result,
        },
      }
    case 'error':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          error: parseRemoteError(payload.error),
        },
      }
    case 'cancel':
    case 'resource_release':
      return { kind, payload: { generation: requireGeneration(payload), id: requireId(payload) } }
    case 'resource_open':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          resource_type: requireString(payload, 'resource_type'),
        },
      }
    case 'stream_open':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          resource_type: requireString(payload, 'resource_type'),
          credit_bytes: requireUint(payload, 'credit_bytes'),
        },
      }
    case 'stream_chunk':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          sequence: requireUint(payload, 'sequence'),
          data: requireString(payload, 'data'),
        },
      }
    case 'stream_credit':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          credit_bytes: requireUint(payload, 'credit_bytes'),
        },
      }
    case 'stream_end':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          ...optionalError(payload),
        },
      }
    case 'contribution_register':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          plugin: requireString(payload, 'plugin'),
          service: requireString(payload, 'service'),
        },
      }
    case 'contribution_remove':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          plugin: requireString(payload, 'plugin'),
        },
      }
    case 'event_invoke': {
      const dispatch = payload.dispatch
      if (typeof dispatch !== 'string' || !DISPATCH.has(dispatch)) {
        throw new Error('event_invoke dispatch is missing or unknown')
      }
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          event: requireString(payload, 'event'),
          payload: payload.payload,
          dispatch: dispatch as 'emit' | 'serial' | 'parallel' | 'waterfall',
        },
      }
    }
    case 'continuation_call':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          payload: payload.payload,
        },
      }
    case 'continuation_reply':
      return {
        kind,
        payload: {
          generation: requireGeneration(payload),
          id: requireId(payload),
          payload: payload.payload,
          ...optionalError(payload),
        },
      }
    case 'dispose':
    case 'quiescent':
      return { kind, payload: { generation: requireGeneration(payload) } }
  }
}

/**
 * Whether a decoded frame is cancellation or a terminal fault, which outranks
 * ordinary call and event traffic.
 * @param message - decoded bridge message.
 * @returns true when the frame must be handled before ordinary traffic.
 */
export function isPriorityFrame(message: BridgeMessage): boolean {
  return message.kind === 'cancel'
    || (message.kind === 'event_invoke' && message.payload.event === 'agent/fault')
    || message.kind === 'dispose'
    || message.kind === 'error'
}

function parseHello(payload: Record<string, unknown>): Hello {
  const role = payload.role
  if (typeof role !== 'string' || !ROLES.has(role as BridgeRole)) {
    throw new Error('hello role is missing or unknown')
  }
  const capabilities = payload.capabilities
  if (!Array.isArray(capabilities) || capabilities.some(item => typeof item !== 'string')) {
    throw new Error('hello capabilities must be a string array')
  }
  return {
    bridge_version: requireUint(payload, 'bridge_version'),
    generation: requireGeneration(payload),
    role: role as BridgeRole,
    build: requireString(payload, 'build'),
    schema_digest: requireString(payload, 'schema_digest'),
    capabilities,
  }
}

function parseRemoteError(value: unknown): RemoteError {
  if (!isRecord(value)) throw new Error('remote error must be an object')
  return {
    code: requireString(value, 'code'),
    message: requireString(value, 'message'),
    retryable: requireBoolean(value, 'retryable'),
    cancelled: requireBoolean(value, 'cancelled'),
    ...(value.data === undefined ? {} : { data: value.data }),
  }
}

function optionalError(payload: Record<string, unknown>): { error?: RemoteError } {
  return payload.error === undefined ? {} : { error: parseRemoteError(payload.error) }
}

function requireId(payload: Record<string, unknown>): BridgeId {
  return BridgeId(requireString(payload, 'id'))
}

function requireGeneration(payload: Record<string, unknown>): number {
  return requireUint(payload, 'generation')
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string') throw new Error(`bridge field ${key} must be a string`)
  return value
}

function requireBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key]
  if (typeof value !== 'boolean') throw new Error(`bridge field ${key} must be a boolean`)
  return value
}

function requireUint(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`bridge field ${key} must be a non-negative integer`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
