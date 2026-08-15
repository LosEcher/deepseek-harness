//! Exclusive session lease: a second writer cannot acquire a live session.

use dsh_session_store::{SessionId, SessionLease, SessionLeaseError};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn scratch() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("dsh-session-lease-{nanos}"));
    fs::create_dir_all(&dir).expect("scratch");
    dir
}

#[test]
fn second_writer_cannot_acquire_a_live_session() {
    let dir = scratch();
    let id = SessionId::new("sess-live");
    let first = SessionLease::acquire(&dir, id.clone()).expect("first writer");
    let error = SessionLease::acquire(&dir, id).expect_err("second writer");
    match error {
        SessionLeaseError::AlreadyHeld { session_id, owner } => {
            assert_eq!(session_id, "sess-live");
            assert_eq!(owner, first.owner());
        }
        other => panic!("expected AlreadyHeld, got {other}"),
    }
    first.release().expect("release");
}

#[test]
fn release_allows_a_later_writer() {
    let dir = scratch();
    let first = SessionLease::acquire(&dir, SessionId::new("sess-reuse")).expect("first");
    first.release().expect("release");
    let second = SessionLease::acquire(&dir, SessionId::new("sess-reuse")).expect("second");
    assert_eq!(second.session_id().as_str(), "sess-reuse");
    drop(second);
}

#[test]
fn drop_releases_the_lease() {
    let dir = scratch();
    {
        let _held = SessionLease::acquire(&dir, SessionId::new("sess-drop")).expect("hold");
    }
    SessionLease::acquire(&dir, SessionId::new("sess-drop")).expect("reacquire after drop");
}
