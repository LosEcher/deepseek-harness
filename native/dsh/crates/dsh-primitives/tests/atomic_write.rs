//! Isolated-directory behavior of atomic replacement.

use dsh_primitives::{write_file_atomic, WriteFileAtomicOptions};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn scratch() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("dsh-primitives-atomic-{nanos}"));
    fs::create_dir_all(&dir).expect("scratch");
    dir
}

#[test]
fn creates_parents_and_writes_content() {
    let dir = scratch();
    let target = dir.join("nested").join("deep").join("doc.yaml");
    write_file_atomic(
        &target,
        "a: 1\n",
        WriteFileAtomicOptions {
            mode: 0o600,
            dir_mode: Some(0o700),
        },
    )
    .expect("write");
    assert_eq!(fs::read_to_string(&target).expect("read"), "a: 1\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&target).expect("meta").permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn replaces_existing_content() {
    let dir = scratch();
    let target = dir.join("doc.yaml");
    fs::write(&target, "old").expect("seed");
    write_file_atomic(
        &target,
        "new",
        WriteFileAtomicOptions {
            mode: 0o600,
            dir_mode: None,
        },
    )
    .expect("replace");
    assert_eq!(fs::read_to_string(&target).expect("read"), "new");
}

#[test]
fn replaces_symlink_without_writing_through() {
    let dir = scratch();
    let victim = dir.join("victim");
    fs::write(&victim, "victim-content").expect("victim");
    let target = dir.join("doc.yaml");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&victim, &target).expect("symlink");
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&victim, &target).expect("symlink");
    write_file_atomic(
        &target,
        "replaced",
        WriteFileAtomicOptions {
            mode: 0o600,
            dir_mode: None,
        },
    )
    .expect("replace");
    assert!(!target
        .symlink_metadata()
        .expect("lstat")
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(&target).expect("read"), "replaced");
    assert_eq!(
        fs::read_to_string(&victim).expect("victim"),
        "victim-content"
    );
}

#[test]
fn removes_temp_sibling_when_rename_fails() {
    let dir = scratch();
    let target = dir.join("occupied");
    fs::create_dir(&target).expect("occupy");
    write_file_atomic(
        &target,
        "content",
        WriteFileAtomicOptions {
            mode: 0o600,
            dir_mode: None,
        },
    )
    .expect_err("rename onto a directory fails");
    let leftovers: Vec<_> = fs::read_dir(&dir)
        .expect("list")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}
