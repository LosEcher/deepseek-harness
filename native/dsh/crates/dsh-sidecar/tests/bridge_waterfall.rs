//! Process-level P1 bridge conformance tests for contribution and waterfall
//! continuation semantics (P1 implementation order step 5).
//!
//! The sidecar emits a waterfall `event/invoke`; the client (acting as the
//! guest listener) drives it through `continuation/call` (next()), receives
//! the downstream `continuation/reply`, wraps the result, and terminates
//! with its own `continuation/reply`. Short-circuit (no next()) and
//! stale-continuation rejection are covered too.

use dsh_bridge_protocol::{
    encode_frame, manifest_source_digest, BridgeId, BridgeMessage, BridgeRole, DispatchMode,
    FrameDecoder, Hello, PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const SIDECAR: &str = env!("CARGO_BIN_EXE_dsh-sidecar");
const GENERATION: u64 = 17;

struct TestClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    decoder: FrameDecoder,
}

fn client_hello() -> Hello {
    Hello {
        bridge_version: PROTOCOL_VERSION,
        generation: GENERATION,
        role: BridgeRole::NodeRoot,
        build: "dsh-bridge-test-client".to_owned(),
        schema_digest: manifest_source_digest(),
        capabilities: vec!["test.waterfall".to_owned()],
    }
}

impl TestClient {
    fn spawn() -> Self {
        let mut child = Command::new(SIDECAR)
            .env("DSH_BRIDGE_GENERATION", GENERATION.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("sidecar binary must spawn");
        let stdin = child.stdin.take().expect("stdin pipe must exist");
        let stdout = child.stdout.take().expect("stdout pipe must exist");
        let mut client = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            decoder: FrameDecoder::default(),
        };
        client.complete_handshake();
        client
    }

    fn complete_handshake(&mut self) {
        match self.read_message() {
            BridgeMessage::Hello(peer) => {
                let expected = manifest_source_digest();
                client_hello()
                    .validate_peer(&peer, &expected, &[])
                    .expect("sidecar hello must be valid");
            }
            other => panic!("expected sidecar hello, got {other:?}"),
        }
        self.write(&BridgeMessage::Hello(client_hello()));
    }

    fn write(&mut self, message: &BridgeMessage) {
        let frame = encode_frame(message).expect("message must encode");
        self.stdin
            .write_all(&frame)
            .expect("frame write must succeed");
    }

    fn read_message(&mut self) -> BridgeMessage {
        let mut buffer = [0u8; 4096];
        loop {
            let read = self
                .stdout
                .read(&mut buffer)
                .expect("stdout read must succeed");
            assert!(read > 0, "sidecar stdout closed unexpectedly");
            if let Some(message) = self
                .decoder
                .push(&buffer[..read])
                .expect("frame must decode")
                .into_iter()
                .next()
            {
                return message;
            }
        }
    }

    fn dispose(mut self) {
        self.write(&BridgeMessage::Dispose {
            generation: GENERATION,
        });
        match self.read_message() {
            BridgeMessage::Quiescent { generation } => assert_eq!(generation, GENERATION),
            other => panic!("expected quiescent, got {other:?}"),
        }
        let status = self.child.wait().expect("sidecar must exit");
        assert!(status.success(), "sidecar must exit cleanly, got {status}");
    }
}

/// Waits for the sidecar's waterfall `event/invoke` and returns its id.
fn await_event_invoke(client: &mut TestClient) -> BridgeId {
    match client.read_message() {
        BridgeMessage::EventInvoke {
            id,
            event,
            payload,
            dispatch,
            ..
        } => {
            assert_eq!(event, "test.waterfall");
            assert_eq!(dispatch, DispatchMode::Waterfall);
            assert_eq!(payload["seed"], "hello");
            id
        }
        other => panic!("expected event/invoke, got {other:?}"),
    }
}

#[test]
fn waterfall_listener_calls_next_wraps_and_terminates() {
    let mut client = TestClient::spawn();
    let request_id = BridgeId::new("req-waterfall").expect("id must be valid");
    client.write(&BridgeMessage::Call {
        generation: GENERATION,
        id: request_id.clone(),
        service: "test".to_owned(),
        method: "waterfall".to_owned(),
        args: json!({ "event": "test.waterfall", "payload": { "seed": "hello" } }),
    });

    // The sidecar emits the event; we act as a waterfall listener.
    let continuation_id = await_event_invoke(&mut client);

    // next(): pass the payload downstream.
    client.write(&BridgeMessage::ContinuationCall {
        generation: GENERATION,
        id: continuation_id.clone(),
        payload: json!({ "value": 1 }),
    });
    // The sidecar answers as the downstream listener, wrapping the payload.
    let downstream = match client.read_message() {
        BridgeMessage::ContinuationReply {
            id: reply_id,
            payload,
            error,
            ..
        } if reply_id == continuation_id => {
            assert!(error.is_none(), "downstream must succeed");
            payload
        }
        other => panic!("expected downstream continuation/reply, got {other:?}"),
    };
    let downstream_text = downstream["downstream"]
        .as_str()
        .expect("downstream wraps the payload as a string template");
    assert!(
        downstream_text.contains("value") && downstream_text.contains("1"),
        "downstream must wrap the next() payload, got {downstream_text:?}"
    );

    // Wrap and terminate the waterfall.
    client.write(&BridgeMessage::ContinuationReply {
        generation: GENERATION,
        id: continuation_id,
        payload: json!({ "final": true }),
        error: None,
    });
    let result = match client.read_message() {
        BridgeMessage::Reply {
            id: reply_id,
            result,
            ..
        } if reply_id == request_id => result,
        other => panic!("expected waterfall call reply, got {other:?}"),
    };
    assert_eq!(result["final"], true);
    client.dispose();
}

#[test]
fn waterfall_listener_short_circuits_without_next() {
    let mut client = TestClient::spawn();
    let request_id = BridgeId::new("req-short").expect("id must be valid");
    client.write(&BridgeMessage::Call {
        generation: GENERATION,
        id: request_id.clone(),
        service: "test".to_owned(),
        method: "waterfall".to_owned(),
        args: json!({ "event": "test.waterfall", "payload": { "seed": "hello" } }),
    });
    let continuation_id = await_event_invoke(&mut client);

    // Short-circuit: reply directly, never calling next().
    client.write(&BridgeMessage::ContinuationReply {
        generation: GENERATION,
        id: continuation_id,
        payload: json!({ "short": true }),
        error: None,
    });
    let result = match client.read_message() {
        BridgeMessage::Reply {
            id: reply_id,
            result,
            ..
        } if reply_id == request_id => result,
        other => panic!("expected short-circuit call reply, got {other:?}"),
    };
    assert_eq!(result["short"], true);
    client.dispose();
}

#[test]
fn stale_continuation_is_rejected_after_consumption() {
    let mut client = TestClient::spawn();
    let request_id = BridgeId::new("req-stale").expect("id must be valid");
    client.write(&BridgeMessage::Call {
        generation: GENERATION,
        id: request_id.clone(),
        service: "test".to_owned(),
        method: "waterfall".to_owned(),
        args: json!({ "event": "test.waterfall", "payload": { "seed": "hello" } }),
    });
    let continuation_id = await_event_invoke(&mut client);

    // Terminate normally.
    client.write(&BridgeMessage::ContinuationReply {
        generation: GENERATION,
        id: continuation_id.clone(),
        payload: json!({ "done": true }),
        error: None,
    });
    match client.read_message() {
        BridgeMessage::Reply { id: reply_id, .. } if reply_id == request_id => {}
        other => panic!("expected call reply, got {other:?}"),
    }

    // A late continuation/call on the consumed id must be rejected.
    client.write(&BridgeMessage::ContinuationCall {
        generation: GENERATION,
        id: continuation_id.clone(),
        payload: json!({ "late": true }),
    });
    match client.read_message() {
        BridgeMessage::Error {
            id: reply_id,
            error,
            ..
        } if reply_id == continuation_id => {
            assert_eq!(error.code, "bridge.stale_continuation");
        }
        other => panic!("expected stale continuation error, got {other:?}"),
    }
    client.dispose();
}

#[test]
fn contribution_register_and_remove_round_trip() {
    let mut client = TestClient::spawn();
    let register_id = BridgeId::new("req-reg").expect("id must be valid");
    client.write(&BridgeMessage::ContributionRegister {
        generation: GENERATION,
        id: register_id.clone(),
        plugin: "probe".to_owned(),
        service: "probe.listener".to_owned(),
    });
    match client.read_message() {
        BridgeMessage::Reply {
            id: reply_id,
            result,
            ..
        } if reply_id == register_id => {
            assert_eq!(result["registered"], true);
            assert_eq!(result["service"], "probe.listener");
        }
        other => panic!("expected contribution register reply, got {other:?}"),
    }

    let remove_id = BridgeId::new("req-rem").expect("id must be valid");
    client.write(&BridgeMessage::ContributionRemove {
        generation: GENERATION,
        id: remove_id.clone(),
        plugin: "probe".to_owned(),
    });
    match client.read_message() {
        BridgeMessage::Reply {
            id: reply_id,
            result,
            ..
        } if reply_id == remove_id => {
            assert_eq!(result["removed"], true);
        }
        other => panic!("expected contribution remove reply, got {other:?}"),
    }
    client.dispose();
}

#[test]
fn event_invoke_without_listener_fails_with_typed_error() {
    let mut client = TestClient::spawn();
    let id = BridgeId::new("req-ev").expect("id must be valid");
    client.write(&BridgeMessage::EventInvoke {
        generation: GENERATION,
        id: id.clone(),
        event: "nobody.listens".to_owned(),
        payload: Value::Null,
        dispatch: DispatchMode::Emit,
    });
    match client.read_message() {
        BridgeMessage::Error {
            id: reply_id,
            error,
            ..
        } if reply_id == id => {
            assert_eq!(error.code, "bridge.no_listener");
        }
        other => panic!("expected no-listener error, got {other:?}"),
    }
    client.dispose();
}
