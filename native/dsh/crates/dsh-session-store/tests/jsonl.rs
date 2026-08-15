//! JSONL append and replay for an isolated session log.

use dsh_session_store::{append_jsonl, read_jsonl};
use serde_json::json;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn appends_and_reads_canonical_rows() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir()
        .join(format!("dsh-session-jsonl-{nanos}"))
        .join("session.jsonl");
    append_jsonl(&path, &json!({"type": "session/start", "seq": 1})).expect("first");
    append_jsonl(&path, &json!({"type": "turn/start", "seq": 2})).expect("second");
    let rows = read_jsonl(&path).expect("read");
    assert_eq!(
        rows,
        vec![
            json!({"type": "session/start", "seq": 1}),
            json!({"type": "turn/start", "seq": 2}),
        ]
    );
    let text = fs::read_to_string(&path).expect("bytes");
    assert!(text.ends_with('\n'));
    assert_eq!(text.lines().count(), 2);
}

#[test]
fn missing_file_is_an_empty_log() {
    let rows =
        read_jsonl(std::env::temp_dir().join("dsh-session-jsonl-missing.jsonl")).expect("missing");
    assert!(rows.is_empty());
}

#[test]
fn rejects_a_torn_non_json_line() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("dsh-session-jsonl-bad-{nanos}.jsonl"));
    fs::write(&path, "{\"ok\":true}\nnot-json\n").expect("seed");
    let error = read_jsonl(&path).expect_err("invalid");
    assert!(error.to_string().contains("line 2"), "{error}");
}
