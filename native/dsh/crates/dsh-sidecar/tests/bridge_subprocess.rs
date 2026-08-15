//! Process-level P1 bridge conformance tests for the subprocess service.
//!
//! Spawns the real `dsh-sidecar` over pipes and verifies: collect mode with
//! exit codes and stderr separation, spill reporting, process-tree
//! termination, piped output streams under receiver credit, cancellation,
//! and a clean dispose after a live process.

use dsh_bridge_protocol::{
    encode_frame, manifest_source_digest, BridgeId, BridgeMessage, BridgeRole, FrameDecoder, Hello,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const SIDECAR: &str = env!("CARGO_BIN_EXE_dsh-sidecar");
const GENERATION: u64 = 11;

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
            "subprocess.runCollect".to_owned(),
            "subprocess.spawn".to_owned(),
            "fs.resolve".to_owned(),
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
                        "retryable": error.retryable,
                        "cancelled": error.cancelled,
                    }))
                }
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

/// Runs a command through `runCollect` with a tiny in-memory cap so that a
/// small output spills, then verifies the spill report.
#[test]
fn run_collect_captures_output_exit_code_and_spill() {
    let mut client = TestClient::spawn();
    let result = client
        .call(
            "subprocess",
            "runCollect",
            json!({
                "command": "sh",
                "args": ["-c", "echo out; echo err >&2; exit 3"],
                "maxBytes": 4096,
            }),
        )
        .expect("runCollect must succeed");
    assert_eq!(result["exit_code"], 3);
    assert_eq!(result["stdout"], "out\n");
    assert_eq!(result["stderr"], "err\n");
    assert_eq!(result["spilled"], false);
    client.dispose();
}

#[test]
fn run_collect_spills_output_beyond_cap() {
    let mut client = TestClient::spawn();
    // Emit 16 KiB of output with a 256-byte cap.
    let result = client
        .call(
            "subprocess",
            "runCollect",
            json!({
                "command": "sh",
                "args": ["-c", "i=0; while [ $i -lt 512 ]; do echo 0123456789abcdef0123456789abcdef; i=$((i+1)); done"],
                "maxBytes": 256,
            }),
        )
        .expect("runCollect must succeed");
    assert_eq!(result["spilled"], true);
    let spill_path = result["spill_path"]
        .as_str()
        .expect("spill path must be reported");
    let spilled = std::fs::read_to_string(spill_path).expect("spill file must exist");
    let in_memory = result["stdout"].as_str().expect("stdout must be present");
    assert!(
        in_memory.len() <= 256 + 40,
        "in-memory output must stay near the cap"
    );
    assert!(
        spilled.contains("0123456789abcdef"),
        "spill file must hold the overflow"
    );
    client.dispose();
}

#[test]
fn run_collect_cancel_kills_the_process_tree() {
    let mut client = TestClient::spawn();
    let id = BridgeId::new("req-kill").expect("id must be valid");
    // A child that spawns a grandchild; killing the group must take both.
    let pid_file = std::env::temp_dir().join(format!(
        "dsh-sub-{}-{}.pid",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    client.write(&BridgeMessage::Call {
        generation: GENERATION,
        id: id.clone(),
        service: "subprocess".to_owned(),
        method: "runCollect".to_owned(),
        args: json!({
            "command": "sh",
            "args": ["-c", format!(
                "echo $$ > {pid}; sleep 60",
                pid = pid_file.to_string_lossy()
            )],
        }),
    });
    // Wait for the child to write its pid, then cancel.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let child_pid = loop {
        if std::path::Path::new(&pid_file).exists() {
            break std::fs::read_to_string(&pid_file)
                .expect("pid file must be readable")
                .trim()
                .to_owned();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "child never wrote its pid"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
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
                assert!(error.cancelled);
                break;
            }
            other => {
                let _ = other;
            }
        }
    }
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "cancel must abort promptly"
    );
    // The process group kill must reap the shell and its sleep grandchild.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let alive = Command::new("kill")
            .arg("-0")
            .arg(&child_pid)
            .status()
            .expect("kill -0 must run")
            .success();
        if !alive {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "process tree survived cancel"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = std::fs::remove_file(&pid_file);
    client.dispose();
}

#[test]
fn spawn_piped_streams_output_under_credit() {
    let mut client = TestClient::spawn();
    let spawned = client
        .call(
            "subprocess",
            "spawn",
            json!({
                "command": "sh",
                "args": ["-c", "echo one; echo two; sleep 0.2"],
            }),
        )
        .expect("spawn must succeed");
    let stdout_id = BridgeId::new(spawned["stdout"].as_str().expect("stdout id").to_owned())
        .expect("stdout id must be valid");

    // Open the stream with 4 bytes of credit: the first chunk must be capped.
    client.write(&BridgeMessage::StreamOpen {
        generation: GENERATION,
        id: stdout_id.clone(),
        resource_type: "stdout".to_owned(),
        credit_bytes: 4,
    });
    match client.read_message() {
        BridgeMessage::Reply {
            id: reply_id,
            result,
            ..
        } if reply_id == stdout_id => assert_eq!(result["opened"], true),
        other => panic!("expected stream open reply, got {other:?}"),
    }

    // First chunk respects the credit cap.
    let first = match client.read_message() {
        BridgeMessage::StreamChunk {
            id: reply_id,
            sequence,
            data,
            ..
        } if reply_id == stdout_id => {
            assert_eq!(sequence, 0);
            data
        }
        other => panic!("expected first chunk, got {other:?}"),
    };
    assert!(
        first.len() <= 4,
        "first chunk must respect credit, got {} bytes",
        first.len()
    );

    // Grant more credit; the rest of the output must arrive.
    client.write(&BridgeMessage::StreamCredit {
        generation: GENERATION,
        id: stdout_id.clone(),
        credit_bytes: 4096,
    });
    let mut collected = first.clone();
    let mut expected_sequence = 1u64;
    loop {
        match client.read_message() {
            BridgeMessage::StreamChunk {
                id: reply_id,
                sequence,
                data,
                ..
            } if reply_id == stdout_id => {
                assert_eq!(sequence, expected_sequence, "chunks must be ordered");
                expected_sequence += 1;
                collected.extend_from_slice(&data);
            }
            BridgeMessage::StreamEnd {
                id: reply_id,
                error,
                ..
            } if reply_id == stdout_id => {
                assert!(error.is_none(), "stream must end cleanly");
                break;
            }
            other => panic!("unexpected frame while reading stream: {other:?}"),
        }
    }
    let text = String::from_utf8(collected).expect("output must be utf-8");
    assert!(
        text.contains("one"),
        "stdout must carry first line, got {text:?}"
    );
    assert!(
        text.contains("two"),
        "stdout must carry second line, got {text:?}"
    );

    // Release the process; then dispose must still quiesce cleanly.
    client.write(&BridgeMessage::ResourceRelease {
        generation: GENERATION,
        id: BridgeId::new(
            spawned["processId"]
                .as_str()
                .expect("process id")
                .to_owned(),
        )
        .expect("process id must be valid"),
    });
    loop {
        match client.read_message() {
            BridgeMessage::Reply { .. } => break,
            other => {
                let _ = other;
            }
        }
    }
    client.dispose();
}

#[test]
fn spawn_piped_cancel_terminates_stream_and_process() {
    let mut client = TestClient::spawn();
    let spawned = client
        .call(
            "subprocess",
            "spawn",
            json!({ "command": "sh", "args": ["-c", "sleep 60"] }),
        )
        .expect("spawn must succeed");
    let process_id = BridgeId::new(
        spawned["processId"]
            .as_str()
            .expect("process id")
            .to_owned(),
    )
    .expect("process id must be valid");
    let stdout_id = BridgeId::new(spawned["stdout"].as_str().expect("stdout id").to_owned())
        .expect("stdout id must be valid");

    client.write(&BridgeMessage::StreamOpen {
        generation: GENERATION,
        id: stdout_id.clone(),
        resource_type: "stdout".to_owned(),
        credit_bytes: 4096,
    });
    loop {
        match client.read_message() {
            BridgeMessage::Reply { .. } => break,
            other => {
                let _ = other;
            }
        }
    }

    client.write(&BridgeMessage::Cancel {
        generation: GENERATION,
        id: process_id,
    });
    loop {
        match client.read_message() {
            BridgeMessage::StreamEnd {
                id: reply_id,
                error,
                ..
            } if reply_id == stdout_id => {
                let error = error.expect("cancelled stream must carry an error");
                assert_eq!(error.code, "cancelled");
                assert!(error.cancelled);
                break;
            }
            other => {
                let _ = other;
            }
        }
    }
    client.dispose();
}
