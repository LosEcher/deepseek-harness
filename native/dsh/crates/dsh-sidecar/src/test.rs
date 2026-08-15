//! Test-only services used by the P1 bridge conformance tests.

use dsh_bridge_protocol::{BridgeId, BridgeMessage};
use dsh_bridge_runtime::{CallContext, ContinuationMessage, FrameSink, Service, ServiceError};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// `test` service: deterministic delays, counters and waterfall semantics
/// for bridge tests.
#[derive(Debug, Default)]
pub struct TestService;

impl TestService {
    /// Creates the service.
    pub fn new() -> Self {
        Self
    }

    /// `sleep(millis)` -> `{ slept_millis }`
    ///
    /// Polls the cancel flag while sleeping; returns `cancelled` when the
    /// peer aborts the request.
    fn sleep(&self, args: &Value, ctx: &CallContext) -> Result<Value, ServiceError> {
        let millis = args
            .get("millis")
            .and_then(Value::as_u64)
            .ok_or_else(|| ServiceError::new("test.bad_args", "missing u64 arg `millis`"))?;
        let deadline = Instant::now() + Duration::from_millis(millis);
        while Instant::now() < deadline {
            if ctx.is_cancelled() {
                return Err(ServiceError::cancelled());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(json!({ "slept_millis": millis }))
    }

    /// `waterfall { event, payload, downstream? }` -> downstream result
    ///
    /// Emits a waterfall event whose listener (the peer) is expected to call
    /// `next()` via `continuation/call`. The sidecar answers that call as the
    /// downstream listener, wrapping the payload, then the peer's terminal
    /// `continuation/reply` becomes the result. When `short_circuit` is set
    /// the peer skips `next()` entirely and replies directly.
    fn waterfall(
        &self,
        args: &Value,
        ctx: &CallContext,
        sink: Arc<dyn FrameSink>,
    ) -> Result<Value, ServiceError> {
        let event = args
            .get("event")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceError::new("test.bad_args", "missing string arg `event`"))?
            .to_owned();
        let payload = args.get("payload").cloned().unwrap_or(Value::Null);
        let downstream = args
            .get("downstream")
            .and_then(Value::as_str)
            .unwrap_or("downstream:{}")
            .to_owned();

        // A continuation id names the waterfall; the runtime routes the
        // peer's continuation frames to the receiver we open now.
        let continuation_id = BridgeId::new(format!("wf-{}", ctx.id.as_str()))
            .map_err(|error| ServiceError::new("test.bad_args", error))?;
        let receiver = sink.open_continuation(&continuation_id);

        sink.send(BridgeMessage::EventInvoke {
            generation: ctx.generation,
            id: continuation_id.clone(),
            event,
            payload,
            dispatch: dsh_bridge_protocol::DispatchMode::Waterfall,
        })
        .map_err(|error| ServiceError::new("test.io", error.to_string()))?;

        // Wait for the peer's next()/short-circuit with a bounded timeout so
        // a broken test fails loudly instead of hanging the connection.
        let deadline = Instant::now() + Duration::from_secs(15);
        let first = wait_continuation(&receiver, deadline, ctx)?;
        let result = match first {
            ContinuationMessage::Call { payload } => {
                // Act as the downstream listener: wrap the payload, reply,
                // and wait for the peer's terminal continuation/reply.
                let wrapped =
                    json!({ "downstream": downstream.replace("{}", payload.to_string().as_str()) });
                sink.send(BridgeMessage::ContinuationReply {
                    generation: ctx.generation,
                    id: continuation_id.clone(),
                    payload: wrapped,
                    error: None,
                })
                .map_err(|error| ServiceError::new("test.io", error.to_string()))?;
                match wait_continuation(&receiver, deadline, ctx)? {
                    ContinuationMessage::Reply { payload, error } => match error {
                        Some(error) => return Err(ServiceError::new(error.code, error.message)),
                        None => payload,
                    },
                    ContinuationMessage::Call { .. } => {
                        return Err(ServiceError::new(
                            "test.protocol",
                            "peer called next() after the terminal reply",
                        ))
                    }
                }
            }
            ContinuationMessage::Reply { payload, error } => match error {
                Some(error) => return Err(ServiceError::new(error.code, error.message)),
                None => payload,
            },
        };
        Ok(result)
    }
}

fn wait_continuation(
    receiver: &std::sync::mpsc::Receiver<ContinuationMessage>,
    deadline: Instant,
    ctx: &CallContext,
) -> Result<ContinuationMessage, ServiceError> {
    loop {
        if ctx.is_cancelled() {
            return Err(ServiceError::cancelled());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ServiceError::new(
                "test.timeout",
                "peer did not continue the waterfall in time",
            ));
        }
        match receiver.recv_timeout(remaining) {
            Ok(message) => return Ok(message),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ServiceError::new(
                    "test.protocol",
                    "continuation channel closed before a reply",
                ))
            }
        }
    }
}

impl Service for TestService {
    fn service_name(&self) -> &str {
        "test"
    }

    fn call(
        &self,
        method: &str,
        args: &Value,
        ctx: &CallContext,
        sink: Arc<dyn FrameSink>,
    ) -> Result<Value, ServiceError> {
        match method {
            "sleep" => self.sleep(args, ctx),
            "waterfall" => self.waterfall(args, ctx, sink),
            other => Err(ServiceError::new(
                "bridge.no_method",
                format!("test.{other} is not served in this migration phase"),
            )),
        }
    }
}
