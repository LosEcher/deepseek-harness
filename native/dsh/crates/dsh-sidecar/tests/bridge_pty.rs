//! Process-level P1 bridge conformance tests for the PTY service.
//!
//! Spawns the real `dsh-sidecar` over pipes and verifies: PTY allocation,
//! ordered input/output through the master, resize taking effect in the
//! child, signal forwarding, cancellation, and full session quiescence with
//! no leftover process or handle.

use base64::engine::Engine;
use dsh_bridge_protocol::{
    encode_frame, manifest_source_digest, BridgeId, BridgeMessage, BridgeRole, FrameDecoder, Hello,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const SIDECAR: &str = env!("CARGO_BIN_EXE_dsh-sidecar");
const GENERATION: u64 = 13;

struct TestClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    decoder: FrameDecoder,
    next_id: u64,
}

fn client_hello() -> Hello {
    Hello {
        bridge_version: PROTOCOL_VERSION,
        generation: GENERATION,
        role: BridgeRole::NodeRoot,
        build: "dsh-bridge-test-client".to_owned(),
        schema_digest: manifest_source_digest(),
        capabilities: vec![
            "pty.open".to_owned(),
            "pty.write".to_owned(),
            "pty.resize".to_owned(),
            "pty.signal".to_owned(),
        ],
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
            next_id: 1,
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

    fn call(&mut self, service: &str, method: &str, args: Value) -> Result<Value, Value> {
        let id = BridgeId::new(format!("req-{}", self.next_id)).expect("id must be valid");
        self.next_id += 1;
        self.write(&BridgeMessage::Call {
            generation: GENERATION,
            id: id.clone(),
            service: service.to_owned(),
            method: method.to_owned(),
            args,
        });
        loop {
            match self.read_message() {
                BridgeMessage::Reply {
                    id: reply_id,
                    result,
                    ..
                } if reply_id == id => return Ok(result),
                BridgeMessage::Error {
                    id: reply_id,
                    error,
                    ..
                } if reply_id == id => {
                    return Err(json!({
                        "code": error.code,
                        "message": error.message,
                        "cancelled": error.cancelled,
                    }))
                }
                other => {
                    let _ = other;
                }
            }
        }
    }

    fn open_stream(&mut self, id: &BridgeId, credit: u32) {
        self.write(&BridgeMessage::StreamOpen {
            generation: GENERATION,
            id: id.clone(),
            resource_type: "output".to_owned(),
            credit_bytes: credit,
        });
        loop {
            match self.read_message() {
                BridgeMessage::Reply { .. } => break,
                other => {
                    let _ = other;
                }
            }
        }
    }

    /// Reads until the output stream ends; returns all chunks plus the end error.
    fn drain_stream(
        &mut self,
        id: &BridgeId,
        timeout: std::time::Duration,
    ) -> (Vec<u8>, Option<Value>) {
        let deadline = std::time::Instant::now() + timeout;
        let mut data = Vec::new();
        let end_error = loop {
            assert!(
                std::time::Instant::now() < deadline,
                "stream did not end within {timeout:?}"
            );
            match self.read_message() {
                BridgeMessage::StreamChunk {
                    id: reply_id,
                    data: chunk,
                    ..
                } if reply_id == *id => data.extend_from_slice(&chunk),
                BridgeMessage::StreamEnd {
                    id: reply_id,
                    error,
                    ..
                } if reply_id == *id => {
                    break error
                        .map(|error| json!({ "code": error.code, "cancelled": error.cancelled }));
                }
                other => {
                    let _ = other;
                }
            }
        };
        (data, end_error)
    }

    /// Reads chunks until `needle` appears in the accumulated bytes or the
    /// timeout expires; the stream may stay open (long-lived session).
    fn collect_until(
        &mut self,
        id: &BridgeId,
        needle: &[u8],
        timeout_secs: u64,
    ) -> (Vec<u8>, Option<Value>) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let mut data = Vec::new();
        let end_error = loop {
            if data.windows(needle.len()).any(|window| window == needle) {
                break None;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "needle not observed within {timeout_secs}s; got {:?}",
                String::from_utf8_lossy(&data)
            );
            match self.read_message() {
                BridgeMessage::StreamChunk {
                    id: reply_id,
                    data: chunk,
                    ..
                } if reply_id == *id => data.extend_from_slice(&chunk),
                BridgeMessage::StreamEnd {
                    id: reply_id,
                    error,
                    ..
                } if reply_id == *id => {
                    break error
                        .map(|error| json!({ "code": error.code, "cancelled": error.cancelled }));
                }
                other => {
                    let _ = other;
                }
            }
        };
        (data, end_error)
    }

    /// Releases a resource and drains any reply.
    fn release(&mut self, id: &Value) {
        let id = BridgeId::new(id.as_str().expect("id").to_owned()).expect("id must be valid");
        self.write(&BridgeMessage::ResourceRelease {
            generation: GENERATION,
            id,
        });
        loop {
            match self.read_message() {
                BridgeMessage::Reply { .. } => break,
                other => {
                    let _ = other;
                }
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

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// PTY input echoes back through the master, preserving order.
#[test]
fn pty_echo_round_trip_preserves_order() {
    let mut client = TestClient::spawn();
    let opened = client
        .call(
            "pty",
            "open",
            json!({
                "command": "sh",
                "args": ["-c", "cat"],
                "cols": 80,
                "rows": 24,
            }),
        )
        .expect("pty open must succeed");
    let output_id = BridgeId::new(opened["output"].as_str().expect("output id").to_owned())
        .expect("output id must be valid");
    client.open_stream(&output_id, 8192);

    client
        .call(
            "pty",
            "write",
            json!({ "ptyId": opened["ptyId"], "data": b64(b"hello-pty\n") }),
        )
        .expect("pty write must succeed");

    // `cat` keeps the session alive, so wait for the echoed bytes instead of
    // the stream end; the release below terminates the session.
    let (data, _end_error) = client.collect_until(&output_id, b"hello-pty", 10);
    let text = String::from_utf8_lossy(&data);
    assert!(
        text.contains("hello-pty"),
        "pty must echo the written input, got {text:?}"
    );
    client.release(&opened["ptyId"]);
    client.dispose();
}

/// Resize propagates to the child (stty sees the new size).
#[test]
fn pty_resize_reaches_the_child() {
    let mut client = TestClient::spawn();
    let opened = client
        .call(
            "pty",
            "open",
            json!({
                "command": "sh",
                "args": ["-c", "sleep 0.5; stty size"],
                "cols": 80,
                "rows": 24,
            }),
        )
        .expect("pty open must succeed");
    let output_id = BridgeId::new(opened["output"].as_str().expect("output id").to_owned())
        .expect("output id must be valid");
    client.open_stream(&output_id, 8192);

    // Resize while the child sleeps; stty must report the new size.
    std::thread::sleep(std::time::Duration::from_millis(200));
    client
        .call(
            "pty",
            "resize",
            json!({ "ptyId": opened["ptyId"], "cols": 132, "rows": 43 }),
        )
        .expect("pty resize must succeed");

    let (data, end_error) = client.drain_stream(&output_id, std::time::Duration::from_secs(10));
    assert!(end_error.is_none());
    let text = String::from_utf8_lossy(&data);
    // `stty size` prints "rows cols".
    assert!(
        text.contains("43 132"),
        "stty must report resized terminal, got {text:?}"
    );
    client.dispose();
}

/// Signal forwarding terminates the foreground child.
#[test]
fn pty_signal_terminates_the_child() {
    let mut client = TestClient::spawn();
    let opened = client
        .call(
            "pty",
            "open",
            json!({
                "command": "sh",
                "args": ["-c", "trap '' TERM; sleep 60"],
            }),
        )
        .expect("pty open must succeed");
    let output_id = BridgeId::new(opened["output"].as_str().expect("output id").to_owned())
        .expect("output id must be valid");
    client.open_stream(&output_id, 8192);

    client
        .call(
            "pty",
            "signal",
            json!({ "ptyId": opened["ptyId"], "signal": "SIGKILL" }),
        )
        .expect("pty signal must succeed");

    // A killed session ends the output stream (possibly with an error).
    let (_data, _end_error) = client.drain_stream(&output_id, std::time::Duration::from_secs(10));
    client.dispose();
}

/// Cancelling a pty session terminates the child and the stream reports it.
#[test]
fn pty_cancel_terminates_session_and_stream() {
    let mut client = TestClient::spawn();
    let opened = client
        .call(
            "pty",
            "open",
            json!({ "command": "sh", "args": ["-c", "sleep 60"] }),
        )
        .expect("pty open must succeed");
    let output_id = BridgeId::new(opened["output"].as_str().expect("output id").to_owned())
        .expect("output id must be valid");
    let pty_id = BridgeId::new(opened["ptyId"].as_str().expect("pty id").to_owned())
        .expect("pty id must be valid");
    client.open_stream(&output_id, 8192);

    client.write(&BridgeMessage::Cancel {
        generation: GENERATION,
        id: pty_id,
    });
    let (data, end_error) = client.drain_stream(&output_id, std::time::Duration::from_secs(10));
    assert!(
        end_error.is_some(),
        "cancelled pty session must end with a typed error, got data {data:?}"
    );
    client.dispose();
}
