use crate::error::RuntimeError;
use dsh_bridge_protocol::{BridgeId, BridgeMessage, RemoteError};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Per-request context passed to a service implementation.
#[derive(Debug)]
pub struct CallContext {
    /// Connection generation that owns this request.
    pub generation: u64,
    /// Request identifier echoed in the reply.
    pub id: BridgeId,
    /// Set once a `cancel` frame for this request arrives.
    pub cancel: Arc<AtomicBool>,
}

impl CallContext {
    /// Returns whether the peer has cancelled this request.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

/// Push channel from a service back to the connection writer.
///
/// A service receives a sink on every call and stream-open so it can emit
/// `stream/chunk`, `stream/end` and `resource/open` frames under the
/// connection's write lock, in any worker thread.
pub trait FrameSink: Send + Sync {
    /// Writes one bridge frame to the peer.
    fn send(&self, message: BridgeMessage) -> Result<(), RuntimeError>;
}

/// A capability service exposed over the bridge.
///
/// Implementations must be `Send + Sync`: the runtime dispatches calls on
/// worker threads so that one slow request never blocks the frame reader.
pub trait Service: Send + Sync {
    /// Registered service name used as the `service` field of a call.
    fn service_name(&self) -> &str;

    /// Invokes one method of this service.
    ///
    /// Implementations should poll [`CallContext::is_cancelled`] on long
    /// operations and return [`ServiceError::cancelled`] when the peer asked
    /// to abort.
    fn call(
        &self,
        method: &str,
        args: &Value,
        ctx: &CallContext,
        sink: Arc<dyn FrameSink>,
    ) -> Result<Value, ServiceError>;

    /// Returns whether this service owns the given resource or stream id.
    ///
    /// Owned ids receive `stream/open`, `stream/credit`, `resource/release`
    /// and `cancel` frames.
    fn owns(&self, _id: &BridgeId) -> bool {
        false
    }

    /// Opens a stream whose id this service owns.
    ///
    /// The default rejects with `bridge.unsupported`; services that support
    /// piped output override it and typically spawn a pump thread that emits
    /// chunks through `sink`.
    fn open_stream(
        &self,
        _id: &BridgeId,
        _resource_type: &str,
        _credit_bytes: u32,
        _ctx: &CallContext,
        _sink: Arc<dyn FrameSink>,
    ) -> Result<(), ServiceError> {
        Err(unsupported("stream/open"))
    }

    /// Grants additional receiver credit to an owned stream.
    fn stream_credit(&self, _id: &BridgeId, _credit_bytes: u32) -> Result<(), ServiceError> {
        Err(unsupported("stream/credit"))
    }

    /// Releases an owned resource (kills processes, closes handles).
    fn release_resource(&self, _id: &BridgeId) -> Result<(), ServiceError> {
        Ok(())
    }

    /// Notifies the service that an owned id was cancelled.
    fn on_cancel(&self, _id: &BridgeId) {}

    /// Ordered shutdown: stop new work and release every owned resource.
    ///
    /// Called by the runtime between `dispose` and `quiescent`, so the exit
    /// criterion "no child processes or open handles after dispose" holds for
    /// every service.
    fn shutdown(&self) {}
}

/// Typed error returned by a service, mapped onto the wire `RemoteError`.
#[derive(Debug, Clone)]
pub struct ServiceError {
    /// Stable machine-readable error identity.
    pub code: String,
    /// Public message, when the protocol defines one.
    pub message: String,
    /// Whether retrying the same operation may succeed.
    pub retryable: bool,
    /// Whether cancellation caused the failure.
    pub cancelled: bool,
    /// Structured details safe for the receiving side to inspect.
    pub data: Option<Value>,
}

impl ServiceError {
    /// Creates a plain non-retryable failure with a stable code.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            cancelled: false,
            data: None,
        }
    }

    /// Marks a failure as retryable.
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// Attaches structured detail.
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    /// Creates the cancellation failure.
    pub fn cancelled() -> Self {
        Self {
            code: "cancelled".to_owned(),
            message: "operation cancelled".to_owned(),
            retryable: false,
            cancelled: true,
            data: None,
        }
    }
}

impl From<ServiceError> for RemoteError {
    fn from(error: ServiceError) -> Self {
        RemoteError {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            cancelled: error.cancelled,
            data: error.data,
        }
    }
}

/// The default rejection for stream/resource frames in this migration phase.
pub(crate) fn unsupported(kind: &str) -> ServiceError {
    ServiceError::new(
        "bridge.unsupported",
        format!("{kind} is not served in this migration phase"),
    )
}
