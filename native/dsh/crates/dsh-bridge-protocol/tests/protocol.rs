use dsh_bridge_protocol::{
    encode_frame, manifest_source_digest, verify_manifest, BridgeId, BridgeLifecycle,
    BridgeMessage, BridgeRole, ContinuationRegistry, FrameDecoder, FrameError, HandshakeError,
    Hello, LifecycleError, ResourceRegistry, StreamState, PROTOCOL_VERSION,
};
use serde_json::json;

const POSITIVE_FIXTURES: &str = include_str!("../../../contracts/bridge-positive.json");
const NEGATIVE_FIXTURES: &str = include_str!("../../../contracts/bridge-negative.json");

fn id(value: &str) -> BridgeId {
    BridgeId::new(value).expect("test id must be valid")
}

fn hello(role: BridgeRole, generation: u64, digest: &str) -> Hello {
    Hello {
        bridge_version: PROTOCOL_VERSION,
        generation,
        role,
        build: "test-build".to_owned(),
        schema_digest: digest.to_owned(),
        capabilities: vec!["call".to_owned(), "stream".to_owned()],
    }
}

#[test]
fn checked_in_manifest_matches_its_source_digest() {
    verify_manifest().expect("checked-in bridge manifest must be fresh");
}

#[test]
fn checked_in_wire_fixtures_accept_positive_and_reject_negative_cases() {
    let positive: serde_json::Value =
        serde_json::from_str(POSITIVE_FIXTURES).expect("positive fixture file must be JSON");
    assert_eq!(positive["source_digest"], manifest_source_digest());
    for case in positive["cases"]
        .as_array()
        .expect("positive cases must be an array")
    {
        serde_json::from_value::<BridgeMessage>(case["message"].clone())
            .unwrap_or_else(|error| panic!("positive case {} failed: {error}", case["name"]));
    }

    let negative: serde_json::Value =
        serde_json::from_str(NEGATIVE_FIXTURES).expect("negative fixture file must be JSON");
    assert_eq!(negative["source_digest"], manifest_source_digest());
    for case in negative["cases"]
        .as_array()
        .expect("negative cases must be an array")
    {
        let error = serde_json::from_value::<BridgeMessage>(case["message"].clone())
            .expect_err("negative wire case must fail")
            .to_string();
        let expected = case["expected_error"]
            .as_str()
            .expect("negative case must name its error fragment");
        assert!(
            error.contains(expected),
            "negative case {} returned {error:?}, expected {expected:?}",
            case["name"]
        );
    }
}

#[test]
fn node_root_accepts_only_the_matching_rust_sidecar_contract() {
    let local = hello(BridgeRole::NodeRoot, 1, "sha256:contract");
    let peer = hello(BridgeRole::RustSidecar, 1, "sha256:contract");
    local
        .validate_peer(&peer, "sha256:contract", &["call", "stream"])
        .expect("matching roles and digest must pass");

    local
        .validate_peer(&hello(BridgeRole::NodeWorker, 1, "sha256:contract"), "sha256:contract", &["call"])
        .expect("node_root must pair with node_worker");

    let wrong_role = hello(BridgeRole::JsGuest, 1, "sha256:contract");
    assert_eq!(
        local.validate_peer(&wrong_role, "sha256:contract", &[]),
        Err(HandshakeError::Role {
            local: BridgeRole::NodeRoot,
            peer: BridgeRole::JsGuest,
        })
    );

    let wrong_digest = hello(BridgeRole::RustSidecar, 1, "sha256:other");
    assert!(matches!(
        local.validate_peer(&wrong_digest, "sha256:contract", &[]),
        Err(HandshakeError::SchemaDigest { .. })
    ));

    let wrong_generation = hello(BridgeRole::RustSidecar, 2, "sha256:contract");
    assert_eq!(
        local.validate_peer(&wrong_generation, "sha256:contract", &[]),
        Err(HandshakeError::Generation { local: 1, peer: 2 })
    );

    let mut missing_capability = hello(BridgeRole::RustSidecar, 1, "sha256:contract");
    missing_capability.capabilities = vec!["call".to_owned()];
    assert_eq!(
        local.validate_peer(&missing_capability, "sha256:contract", &["call", "stream"]),
        Err(HandshakeError::MissingCapability("stream".to_owned()))
    );
}

#[test]
fn framing_survives_arbitrary_chunks_and_back_to_back_messages() {
    let first = BridgeMessage::Hello(hello(BridgeRole::RustRoot, 7, "sha256:contract"));
    let second = BridgeMessage::StreamChunk {
        generation: 7,
        id: id("stream-1"),
        sequence: 0,
        data: vec![0, 1, 2, 253, 254, 255],
    };
    let mut bytes = encode_frame(&first).expect("hello must encode");
    bytes.extend(encode_frame(&second).expect("chunk must encode"));
    assert!(String::from_utf8_lossy(&bytes).contains("AAEC/f7/"));

    let mut decoder = FrameDecoder::default();
    let mut decoded = Vec::new();
    for chunk in bytes.chunks(3) {
        decoded.extend(decoder.push(chunk).expect("valid chunks must decode"));
    }
    assert_eq!(decoded, vec![first, second]);
    assert_eq!(decoder.buffered_len(), 0);
}

#[test]
fn framing_rejects_ambiguous_and_oversized_headers() {
    let mut decoder = FrameDecoder::new(4);
    let duplicate = b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}";
    assert!(matches!(
        decoder.push(duplicate),
        Err(FrameError::DuplicateContentLength)
    ));

    let mut decoder = FrameDecoder::new(1);
    assert!(matches!(
        decoder.push(b"Content-Length: 2\r\n\r\n{}"),
        Err(FrameError::TooLarge { max: 1 })
    ));
}

#[test]
fn wire_decode_rejects_empty_opaque_ids() {
    let invalid = json!({
        "kind": "cancel",
        "payload": { "generation": 1, "id": " " }
    });
    assert!(serde_json::from_value::<BridgeMessage>(invalid).is_err());
}

#[test]
fn disconnect_releases_only_resources_from_its_generation() {
    let mut resources = ResourceRegistry::default();
    resources
        .open(3, id("process"), "subprocess")
        .expect("resource must open");
    resources
        .open(4, id("terminal"), "pty")
        .expect("resource must open");
    assert_eq!(resources.resource_type(&id("terminal")), Some("pty"));
    assert_eq!(resources.release_generation(3), 1);
    assert_eq!(resources.len(), 1);
    assert_eq!(
        resources.release(3, &id("terminal")),
        Err(LifecycleError::GenerationMismatch)
    );
    resources
        .release(4, &id("terminal"))
        .expect("owner must release the remaining resource");
    assert!(resources.is_empty());
}

#[test]
fn stream_enforces_credit_order_and_one_terminal_frame() {
    let stream_id = id("stdout");
    let mut stream = StreamState::new(5, stream_id.clone(), 4);
    stream
        .accept_chunk(5, &stream_id, 0, 4)
        .expect("first chunk must use available credit");
    assert_eq!(
        stream.accept_chunk(5, &stream_id, 1, 1),
        Err(LifecycleError::Credit {
            requested: 1,
            available: 0,
        })
    );
    stream
        .grant(5, &stream_id, 2)
        .expect("receiver may replenish credit");
    assert_eq!(
        stream.accept_chunk(5, &stream_id, 2, 1),
        Err(LifecycleError::Sequence {
            actual: 2,
            expected: 1,
        })
    );
    stream
        .accept_chunk(5, &stream_id, 1, 2)
        .expect("ordered chunk must pass");
    stream
        .finish(5, &stream_id)
        .expect("first terminal frame must pass");
    assert!(stream.is_terminal());
    assert_eq!(stream.finish(5, &stream_id), Err(LifecycleError::Terminal));
}

#[test]
fn continuation_is_one_shot_and_generation_scoped() {
    let continuation_id = id("next-1");
    let mut continuations = ContinuationRegistry::default();
    continuations
        .register(8, continuation_id.clone())
        .expect("continuation must register");
    assert_eq!(
        continuations.register(9, continuation_id.clone()),
        Err(LifecycleError::Duplicate)
    );
    assert_eq!(
        continuations.take(9, &continuation_id),
        Err(LifecycleError::GenerationMismatch)
    );
    continuations
        .take(8, &continuation_id)
        .expect("owner may call continuation once");
    assert_eq!(
        continuations.take(8, &continuation_id),
        Err(LifecycleError::Unknown)
    );
}

#[test]
fn dispose_rejects_new_work_until_owned_state_drains() {
    let mut lifecycle = BridgeLifecycle::default();
    lifecycle
        .begin_work()
        .expect("work must start before dispose");
    lifecycle
        .open_resource(11, id("child"), "subprocess")
        .expect("resource must open before dispose");
    lifecycle
        .register_continuation(11, id("next"))
        .expect("continuation must register before dispose");
    lifecycle
        .open_stream(11, id("stdout"), 4)
        .expect("stream must open before dispose");
    lifecycle.dispose();
    assert_eq!(lifecycle.begin_work(), Err(LifecycleError::Quiescing));
    assert_eq!(
        lifecycle.open_resource(11, id("late"), "pty"),
        Err(LifecycleError::Quiescing)
    );
    assert!(!lifecycle.is_quiescent());

    lifecycle.end_work().expect("accepted work must finish");
    lifecycle.release_generation(11);
    assert!(lifecycle.is_quiescent());
    assert_eq!(lifecycle.end_work(), Err(LifecycleError::NoInFlight));
}
