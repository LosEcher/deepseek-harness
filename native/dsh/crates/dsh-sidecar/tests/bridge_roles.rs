//! Process-level P1 bridge conformance tests for root/guest role inversion
//! (P1 implementation order step 6).
//!
//! The same fixture batch must pass under both pairings:
//! - Node root pairing: peer `NodeRoot` ↔ sidecar `RustSidecar`
//! - inverted pairing: peer `JsGuest` ↔ sidecar `RustRoot` (DSH_BRIDGE_ROLE=rust_root)
//!
//! Running the identical fs/subprocess calls through both proves the bridge
//! is role-symmetric and that swapping the process root does not change
//! fixture behavior.

use dsh_bridge_protocol::{
    encode_frame, manifest_source_digest, BridgeId, BridgeMessage, BridgeRole, FrameDecoder, Hello,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const SIDECAR: &str = env!("CARGO_BIN_EXE_dsh-sidecar");
const GENERATION: u64 = 19;

/// One fixture run over a specific role pairing.
struct RoleClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    decoder: FrameDecoder,
    next_id: u64,
    local_role: BridgeRole,
}

fn hello(role: BridgeRole) -> Hello {
    Hello {
        bridge_version: PROTOCOL_VERSION,
        generation: GENERATION,
        role,
        build: "dsh-bridge-role-test".to_owned(),
        schema_digest: manifest_source_digest(),
        capabilities: vec![
            "fs.resolve".to_owned(),
            "fs.readText".to_owned(),
            "subprocess.runCollect".to_owned(),
        ],
    }
}

impl RoleClient {
    /// Spawns the sidecar in the given role pairing and completes the
    /// handshake.
    fn spawn(peer_role: BridgeRole) -> Self {
        let sidecar_role = match peer_role {
            BridgeRole::NodeRoot => BridgeRole::RustSidecar,
            BridgeRole::JsGuest => BridgeRole::RustRoot,
            other => panic!("unsupported peer role {other:?}"),
        };
        let mut child = Command::new(SIDECAR)
            .env("DSH_BRIDGE_GENERATION", GENERATION.to_string())
            .env(
                "DSH_BRIDGE_ROLE",
                match sidecar_role {
                    BridgeRole::RustRoot => "rust_root",
                    BridgeRole::RustSidecar => "rust_sidecar",
                    _ => unreachable!(),
                },
            )
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
            local_role: peer_role,
        };
        client.complete_handshake(sidecar_role);
        client
    }

    fn complete_handshake(&mut self, expected_sidecar_role: BridgeRole) {
        match self.read_message() {
            BridgeMessage::Hello(peer) => {
                assert_eq!(peer.role, expected_sidecar_role, "sidecar role mismatch");
                let expected = manifest_source_digest();
                hello(self.local_role)
                    .validate_peer(&peer, &expected, &[])
                    .expect("sidecar hello must be valid");
            }
            other => panic!("expected sidecar hello, got {other:?}"),
        }
        self.write(&BridgeMessage::Hello(hello(self.local_role)));
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

/// The shared fixture batch: fs resolve/read and subprocess collect behave
/// identically under either pairing.
fn run_fixture_batch(client: &mut RoleClient) {
    // fs.resolve alias identity.
    let dir = std::env::temp_dir().join(format!(
        "dsh-role-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir must be created");
    let target = dir.join("target.txt");
    std::fs::write(&target, "role-fixture").expect("file must be written");
    let direct = client
        .call("fs", "resolve", json!({ "path": target.to_string_lossy() }))
        .expect("fs.resolve must succeed in this pairing");
    // macOS canonicalizes /var -> /private/var, so compare the resolved
    // target's identity rather than the raw path string.
    assert!(direct["path"]
        .as_str()
        .expect("path")
        .ends_with("/target.txt"));
    assert!(
        direct["identity"]
            .as_str()
            .expect("identity")
            .starts_with("dev:"),
        "resolve must report a stable identity"
    );

    // fs.readText round trip.
    let read = client
        .call(
            "fs",
            "readText",
            json!({ "path": target.to_string_lossy() }),
        )
        .expect("fs.readText must succeed in this pairing");
    assert_eq!(read["text"], "role-fixture");

    // fs.readText missing target -> typed error.
    let missing = client
        .call(
            "fs",
            "readText",
            json!({ "path": dir.join("nope.txt").to_string_lossy() }),
        )
        .expect_err("missing target must error in this pairing");
    assert_eq!(missing["code"], "fs.not_found");

    // subprocess.runCollect exit code and output.
    let collected = client
        .call(
            "subprocess",
            "runCollect",
            json!({
                "command": "sh",
                "args": ["-c", "echo role-ok; exit 5"],
            }),
        )
        .expect("runCollect must succeed in this pairing");
    assert_eq!(collected["exit_code"], 5);
    assert_eq!(collected["stdout"], "role-ok\n");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn node_root_pairing_passes_fixture_batch() {
    let mut client = RoleClient::spawn(BridgeRole::NodeRoot);
    run_fixture_batch(&mut client);
    client.dispose();
}

#[test]
fn inverted_js_guest_pairing_passes_the_same_fixture_batch() {
    let mut client = RoleClient::spawn(BridgeRole::JsGuest);
    run_fixture_batch(&mut client);
    client.dispose();
}

#[test]
fn role_mismatch_rejects_the_connection_fast() {
    // Peer claims NodeRoot while the sidecar runs as RustRoot: the pairing
    // (NodeRoot, RustRoot) is unsupported and must fail the handshake.
    let mut child = Command::new(SIDECAR)
        .env("DSH_BRIDGE_GENERATION", GENERATION.to_string())
        .env("DSH_BRIDGE_ROLE", "rust_root")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("sidecar binary must spawn");
    let mut stdin = child.stdin.take().expect("stdin pipe must exist");
    let mut stdout = child.stdout.take().expect("stdout pipe must exist");

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
    // Send a NodeRoot hello to the RustRoot sidecar: invalid pairing.
    let wrong = hello(BridgeRole::NodeRoot);
    let frame = encode_frame(&BridgeMessage::Hello(wrong)).expect("hello must encode");
    stdin.write_all(&frame).expect("hello write must succeed");
    drop(stdin);

    let status = child.wait().expect("sidecar must exit on role mismatch");
    assert!(
        !status.success(),
        "sidecar must reject the mismatched role pairing"
    );
}
