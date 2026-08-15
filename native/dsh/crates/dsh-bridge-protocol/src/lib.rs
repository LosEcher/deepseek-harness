//! Stable logical messages and local state checks for the migration bridge.
//!
//! The crate deliberately does not own a process runtime or an async executor. It
//! provides the value-level contract that a Rust sidecar and a TypeScript facade
//! can test against before a product profile uses the bridge.

mod framing;
mod handshake;
mod lifecycle;
mod manifest;
mod message;

pub use framing::{encode_frame, write_frame, FrameDecoder, FrameError};
pub use handshake::{BridgeRole, HandshakeError, Hello, PROTOCOL_VERSION};
pub use lifecycle::{
    BridgeLifecycle, ContinuationRegistry, LifecycleError, ResourceRegistry, StreamState,
};
pub use manifest::{manifest_source_digest, verify_manifest, BRIDGE_MANIFEST};
pub use message::{BridgeId, BridgeMessage, DispatchMode, RemoteError};
