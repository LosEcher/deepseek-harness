//! Process-level P1 bridge conformance tests.
//!
//! These spawn the real `dsh-sidecar` binary over pipes and exercise the
//! wire protocol end to end: handshake, `fs.resolve` alias identity, text
//! reads, missing targets, cancellation, atomic mutation in an isolated
//! directory, unsupported request kinds, and a clean dispose/quiescent exit.

use dsh_bridge_protocol::{
    encode_frame, manifest_source_digest, BridgeId, BridgeMessage, BridgeRole, FrameDecoder, Hello,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const SIDECAR: &str = env!("CARGO_BIN_EXE_dsh-sidecar");
const GENERATION: u64 = 7;

/// Client-side peer over the sidecar's stdio pipes.
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
            "fs.resolve".to_owned(),
            "fs.readText".to_owned(),
            "fs.writeTextAtomic".to_owned(),
            "test.sleep".to_owned(),
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
        // Sidecar greets first; we validate and answer with our own hello.
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

    /// Sends a call and waits for its reply or error.
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
                        "retryable": error.retryable,
                        "cancelled": error.cancelled,
                    }))
                }
                other => {
                    // Keep reading: the peer may interleave unrelated frames.
                    if matches!(other, BridgeMessage::Quiescent { .. }) {
                        panic!("sidecar went quiescent before replying to our call");
                    }
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

fn temp_dir(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "dsh-bridge-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).expect("temp dir must be created");
    path
}

#[test]
fn handshake_accepts_matching_roles_and_digest() {
    let client = TestClient::spawn();
    client.dispose();
}

#[test]
fn fs_resolve_reports_canonical_path_and_alias_identity() {
    let dir = temp_dir("resolve");
    let target = dir.join("target.txt");
    std::fs::write(&target, "hello").expect("target must be written");
    let alias = dir.join("alias.txt");
    std::os::unix::fs::symlink(&target, &alias).expect("symlink must be created");

    let mut client = TestClient::spawn();
    let direct = client
        .call("fs", "resolve", json!({ "path": target.to_string_lossy() }))
        .expect("resolve must succeed");
    let via_alias = client
        .call("fs", "resolve", json!({ "path": alias.to_string_lossy() }))
        .expect("resolve must succeed");
    assert_eq!(
        direct["identity"], via_alias["identity"],
        "alias must share identity"
    );
    assert_eq!(
        direct["path"], via_alias["path"],
        "both aliases must canonicalize to the same path"
    );
    client.dispose();
}

#[test]
fn fs_read_text_round_trips_and_reports_missing_target() {
    let dir = temp_dir("read");
    let file = dir.join("message.txt");
    std::fs::write(&file, "hello bridge\n").expect("file must be written");

    let mut client = TestClient::spawn();
    let result = client
        .call("fs", "readText", json!({ "path": file.to_string_lossy() }))
        .expect("readText must succeed");
    assert_eq!(result["text"], "hello bridge\n");

    let missing = dir.join("missing.txt");
    let error = client
        .call(
            "fs",
            "readText",
            json!({ "path": missing.to_string_lossy() }),
        )
        .expect_err("missing target must error");
    assert_eq!(error["code"], "fs.not_found");
    assert_eq!(error["retryable"], false);
    assert_eq!(error["cancelled"], false);
    client.dispose();
}

#[test]
fn fs_write_text_atomic_mutates_inside_isolated_directory() {
    let dir = temp_dir("atomic");
    let target = dir.join("notes.txt");
    let mut client = TestClient::spawn();
    client
        .call(
            "fs",
            "writeTextAtomic",
            json!({ "path": target.to_string_lossy(), "text": "first" }),
        )
        .expect("first write must succeed");
    client
        .call(
            "fs",
            "writeTextAtomic",
            json!({ "path": target.to_string_lossy(), "text": "second" }),
        )
        .expect("overwrite must succeed");

    let read_back = std::fs::read_to_string(&target).expect("target must exist");
    assert_eq!(read_back, "second");
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .expect("dir must be listable")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.contains("dsh-tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "atomic write must not leave temporary files behind: {leftovers:?}"
    );
    client.dispose();
}

#[test]
fn cancel_aborts_an_in_flight_request() {
    let mut client = TestClient::spawn();
    let id = BridgeId::new("req-cancel").expect("id must be valid");
    client.write(&BridgeMessage::Call {
        generation: GENERATION,
        id: id.clone(),
        service: "test".to_owned(),
        method: "sleep".to_owned(),
        args: json!({ "millis": 60_000 }),
    });
    // Give the sidecar a moment to start the request, then cancel it.
    std::thread::sleep(std::time::Duration::from_millis(200));
    let started = std::time::Instant::now();
    client.write(&BridgeMessage::Cancel {
        generation: GENERATION,
        id: id.clone(),
    });
    loop {
        match client.read_message() {
            BridgeMessage::Error {
                id: reply_id,
                error,
                ..
            } if reply_id == id => {
                assert_eq!(error.code, "cancelled");
                assert!(error.cancelled, "error must be marked cancelled");
                assert!(
                    started.elapsed() < std::time::Duration::from_secs(5),
                    "cancel must abort the request promptly"
                );
                break;
            }
            other => {
                // Ignore unrelated frames; only the owned id terminates the wait.
                let _ = other;
            }
        }
    }
    client.dispose();
}

#[test]
fn unsupported_request_kinds_fail_with_typed_error() {
    let mut client = TestClient::spawn();
    let id = BridgeId::new("req-stream").expect("id must be valid");
    client.write(&BridgeMessage::StreamOpen {
        generation: GENERATION,
        id: id.clone(),
        resource_type: "stdout".to_owned(),
        credit_bytes: 4096,
    });
    loop {
        match client.read_message() {
            BridgeMessage::Error {
                id: reply_id,
                error,
                ..
            } if reply_id == id => {
                assert_eq!(error.code, "bridge.unsupported");
                assert!(error.message.contains("stream/open"));
                break;
            }
            other => {
                let _ = other;
            }
        }
    }
    client.dispose();
}

#[test]
fn mismatched_schema_digest_rejects_the_connection_fast() {
    let mut child = Command::new(SIDECAR)
        .env("DSH_BRIDGE_GENERATION", GENERATION.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("sidecar binary must spawn");
    let mut stdin = child.stdin.take().expect("stdin pipe must exist");
    let mut stdout = child.stdout.take().expect("stdout pipe must exist");

    // Read the sidecar hello, then answer with a mismatched schema digest.
    let mut decoder = FrameDecoder::default();
    let mut buffer = [0u8; 4096];
    let mut sidecar_hello = None;
    while sidecar_hello.is_none() {
        let read = stdout.read(&mut buffer).expect("stdout read must succeed");
        for message in decoder.push(&buffer[..read]).expect("frame must decode") {
            if let BridgeMessage::Hello(hello) = message {
                sidecar_hello = Some(hello);
            }
        }
    }
    let mut wrong = client_hello();
    wrong.schema_digest = "sha256:definitely-not-the-contract".to_owned();
    let frame = encode_frame(&BridgeMessage::Hello(wrong)).expect("hello must encode");
    stdin.write_all(&frame).expect("hello write must succeed");
    drop(stdin);

    let status = child
        .wait()
        .expect("sidecar must exit on handshake failure");
    assert!(!status.success(), "sidecar must reject the bad handshake");
}

#[test]
fn dispose_reaches_quiescent_and_sidecar_exits_cleanly() {
    let mut client = TestClient::spawn();
    client.write(&BridgeMessage::Dispose {
        generation: GENERATION,
    });
    match client.read_message() {
        BridgeMessage::Quiescent { generation } => assert_eq!(generation, GENERATION),
        other => panic!("expected quiescent, got {other:?}"),
    }
    let status = client.child.wait().expect("sidecar must exit");
    assert!(
        status.success(),
        "sidecar must exit cleanly after quiescent"
    );
}
