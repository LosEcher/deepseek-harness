use thiserror::Error;

/// Failures that terminate the bridge connection.
///
/// These are the "fast fail" class from the migration note: EOF, malformed
/// framing, protocol mismatch or a dead child reject every pending operation
/// and make the provider unavailable. They are never converted into a
/// [`dsh_bridge_protocol::RemoteError`]; the connection is over.
#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("bridge handshake failed: {0}")]
    Handshake(#[from] dsh_bridge_protocol::HandshakeError),
    #[error("bridge frame error: {0}")]
    Frame(#[from] dsh_bridge_protocol::FrameError),
    #[error("bridge peer closed the connection")]
    PeerClosed,
    #[error("bridge connection died: {0}")]
    Io(#[from] std::io::Error),
    #[error("bridge peer sent a message before the handshake completed")]
    PreHandshake,
    #[error("bridge received a message kind it cannot serve in this phase: {kind}")]
    Unsupported { kind: &'static str },
    #[error("bridge dispatch rejected a request: {0}")]
    Lifecycle(#[from] dsh_bridge_protocol::LifecycleError),
}

/// Exit status classification for a terminated sidecar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideExit {
    /// Clean, ordered shutdown after a `dispose` / `quiescent` exchange.
    Quiescent,
    /// The connection ended without a dispose; treat as abnormal.
    Abnormal,
}
