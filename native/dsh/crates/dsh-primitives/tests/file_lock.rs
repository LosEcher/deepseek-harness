//! Writer-lock refusal when the parent is not a directory.

use dsh_primitives::with_file_lock;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn rejects_a_parent_that_is_not_a_directory() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("dsh-primitives-lock-{nanos}"));
    fs::create_dir_all(&dir).expect("scratch");
    let parent = dir.join("not-a-directory");
    fs::write(&parent, "occupied").expect("file parent");
    let mut called = false;
    let error = with_file_lock(parent.join("document"), || {
        called = true;
    })
    .expect_err("parent is a file");
    assert!(!called);
    let message = error.to_string();
    assert!(
        message.contains("Not a directory")
            || message.contains("not a directory")
            || message.contains("cannot find the path")
            || message.contains("os error"),
        "{message}"
    );
}
