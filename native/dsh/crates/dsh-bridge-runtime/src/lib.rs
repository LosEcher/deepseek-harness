//! Symmetric bridge connection runtime.
//!
//! This crate turns the value-level [`dsh_bridge_protocol`] contract into a
//! working connection: it owns the frame reader/writer on stdio, the
//! handshake, the service registry, per-request cancellation and the
//! dispose/quiescence sequence. It deliberately owns no async executor; the
//! connection is thread-based so that one in-flight request never blocks the
//! reader from processing cancel or nested callback frames.
//!
//! The runtime is symmetric: the same [`serve`] function runs under a Node
//! root (as a Rust sidecar) and, after the process-root inversion, as the
//! Rust root itself.

mod connection;
mod error;
mod service;

pub use connection::{serve, BridgeConfig, MapRegistry, ServiceRegistry};
pub use error::{RuntimeError, SideExit};
pub use service::{CallContext, FrameSink, Service, ServiceError};
