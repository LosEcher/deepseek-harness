//! Test-only services used by the P1 bridge conformance tests.

use dsh_bridge_runtime::{CallContext, Service, ServiceError};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// `test` service: deterministic delays and counters for bridge tests.
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
}

impl Service for TestService {
    fn service_name(&self) -> &str {
        "test"
    }

    fn call(&self, method: &str, args: &Value, ctx: &CallContext) -> Result<Value, ServiceError> {
        match method {
            "sleep" => self.sleep(args, ctx),
            other => Err(ServiceError::new(
                "bridge.no_method",
                format!("test.{other} is not served in this migration phase"),
            )),
        }
    }
}
