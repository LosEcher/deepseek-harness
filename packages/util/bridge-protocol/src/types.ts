/**
 * Wire values shared by the TypeScript and Rust product-bridge codecs.
 * @module @deepseek-ai/dsh-bridge-protocol
 */

/** Bridge protocol version carried by every Hello. */
export const PROTOCOL_VERSION = 1

/** Default maximum logical frame body size for the JSON carrier. */
export const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024

/** Process role used during handshake pairing. */
export type BridgeRole = 'node_root' | 'rust_sidecar' | 'rust_root' | 'js_guest' | 'node_worker'

/** Event dispatch semantics preserved across the bridge. */
export type DispatchMode = 'emit' | 'serial' | 'parallel' | 'waterfall'

/** Opaque identifier owned by one bridge connection generation. */
export type BridgeId = string

/** Hello payload exchanged before any service registration. */
export interface Hello {
  /** Bridge protocol version. */
  readonly bridge_version: number
  /** Connection generation, never reused after a disconnect. */
  readonly generation: number
  /** Role of the sending process. */
  readonly role: BridgeRole
  /** Human-readable build identifier for diagnostics. */
  readonly build: string
  /** Digest of the generated contract manifest. */
  readonly schema_digest: string
  /** Optional capabilities advertised by the sender. */
  readonly capabilities: readonly string[]
}

/** Stable error data carried by a reply or terminal stream frame. */
export interface RemoteError {
  /** Machine-readable error identity. */
  readonly code: string
  /** Public message, when the protocol defines one. */
  readonly message: string
  /** Whether retrying the same operation may succeed. */
  readonly retryable: boolean
  /** Whether cancellation caused the failure. */
  readonly cancelled: boolean
  /** Structured details that are safe for the receiving side to inspect. */
  readonly data?: unknown
}

/** Logical messages exchanged by both bridge roles. */
export type BridgeMessage =
  | { readonly kind: 'hello'; readonly payload: Hello }
  | {
    readonly kind: 'call'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly service: string
      readonly method: string
      readonly args: unknown
    }
  }
  | {
    readonly kind: 'reply'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly result: unknown
    }
  }
  | {
    readonly kind: 'error'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly error: RemoteError
    }
  }
  | {
    readonly kind: 'cancel'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
    }
  }
  | {
    readonly kind: 'resource_open'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly resource_type: string
    }
  }
  | {
    readonly kind: 'resource_release'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
    }
  }
  | {
    readonly kind: 'stream_open'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly resource_type: string
      readonly credit_bytes: number
    }
  }
  | {
    readonly kind: 'stream_chunk'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly sequence: number
      readonly data: string
    }
  }
  | {
    readonly kind: 'stream_credit'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly credit_bytes: number
    }
  }
  | {
    readonly kind: 'stream_end'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly error?: RemoteError
    }
  }
  | {
    readonly kind: 'contribution_register'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly plugin: string
      readonly service: string
    }
  }
  | {
    readonly kind: 'contribution_remove'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly plugin: string
    }
  }
  | {
    readonly kind: 'event_invoke'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly event: string
      readonly payload: unknown
      readonly dispatch: DispatchMode
    }
  }
  | {
    readonly kind: 'continuation_call'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly payload: unknown
    }
  }
  | {
    readonly kind: 'continuation_reply'
    readonly payload: {
      readonly generation: number
      readonly id: BridgeId
      readonly payload: unknown
      readonly error?: RemoteError
    }
  }
  | { readonly kind: 'dispose'; readonly payload: { readonly generation: number } }
  | { readonly kind: 'quiescent'; readonly payload: { readonly generation: number } }

/** Failures raised while decoding or writing Content-Length frames. */
export type FrameErrorCode =
  | 'header-encoding'
  | 'missing-content-length'
  | 'duplicate-content-length'
  | 'header-too-large'
  | 'invalid-content-length'
  | 'too-large'
  | 'json'
  | 'io'

/** Handshake failures that make the provider unavailable. */
export type HandshakeErrorCode =
  | 'version'
  | 'zero-generation'
  | 'generation'
  | 'role'
  | 'schema-digest'
  | 'empty-build'
  | 'empty-capability'
  | 'duplicate-capability'
  | 'missing-capability'
