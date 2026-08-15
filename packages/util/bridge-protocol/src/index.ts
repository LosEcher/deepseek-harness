/**
 * Versioned product-bridge messages, Content-Length framing, and handshake
 * checks. TypeScript owns the semantics; the Rust crate consumes the same JSON.
 * @module @deepseek-ai/dsh-bridge-protocol
 */

export { DEFAULT_MAX_FRAME_SIZE, PROTOCOL_VERSION } from './types.ts'
export type {
  BridgeId,
  BridgeMessage,
  BridgeRole,
  DispatchMode,
  FrameErrorCode,
  HandshakeErrorCode,
  Hello,
  RemoteError,
} from './types.ts'
export { BridgeId as createBridgeId, canPairRoles, HandshakeError, isPriorityFrame, parseBridgeMessage, validatePeerHello } from './message.ts'
export { encodeFrame, FrameDecoder, FrameError } from './framing.ts'
