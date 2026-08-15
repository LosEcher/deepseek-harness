use dsh_bridge_protocol::RemoteError;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Per-request context passed to a service implementation.
#[derive(Debug)]
pub struct CallContext {
    /// Connection generation that owns this request.
    pub generation: u64,
    /// Request identifier echoed in the reply.
    pub id: dsh_bridge_protocol::BridgeId,
    /// Set once a `cancel` frame for this request arrives.
    pub cancel: Arc<AtomicBool>,
}

impl CallContext {
    /// Returns whether the peer has cancelled this request.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
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
    fn call(&self, method: &str, args: &Value, ctx: &CallContext) -> Result<Value, ServiceError>;
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
