//! Atomic file replacement matching `@deepseek-ai/dsh-atomic-write`.
//!
//! The next content is written to a same-directory sibling opened with
//! exclusive create, then renamed over the target. Readers observe either the
//! old or the new complete file. Crash durability (fsync) is out of scope.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;

/// Filesystem options for [`write_file_atomic`]; `mode` is required so the
/// permission decision stays visible at every call site.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteFileAtomicOptions {
    /// Permission bits stamped on the fresh temp inode (subject to umask).
    pub mode: u32,
    /// Permission bits for parent directories this call creates.
    pub dir_mode: Option<u32>,
}

/// Failure while replacing a file atomically.
#[derive(Debug, Error)]
pub enum AtomicWriteError {
    /// Underlying I/O failure.
    #[error("atomic-write: {0}")]
    Io(#[from] io::Error),
}

/// Replace `path` with `content` in one rename, creating parent directories.
///
/// The temp sibling is opened with exclusive create so a planted symlink is
/// refused. The rename replaces a symlinked target itself rather than writing
/// through to its referent. On any failure the temp file is removed.
pub fn write_file_atomic(
    path: impl AsRef<Path>,
    content: impl AsRef<[u8]>,
    options: WriteFileAtomicOptions,
) -> Result<(), AtomicWriteError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        create_parents(parent, options.dir_mode)?;
    }
    let temp = temp_path(path);
    let write_result = (|| {
        let mut file = exclusive_create(&temp, options.mode)?;
        file.write_all(content.as_ref())?;
        drop(file);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

fn create_parents(parent: &Path, dir_mode: Option<u32>) -> io::Result<()> {
    if parent.as_os_str().is_empty() || parent.exists() {
        return Ok(());
    }
    match dir_mode {
        Some(mode) => create_dir_all_mode(parent, mode),
        None => fs::create_dir_all(parent),
    }
}

fn create_dir_all_mode(path: &Path, mode: u32) -> io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            create_dir_all_mode(parent, mode)?;
        }
    }
    mkdir_mode(path, mode)
}

fn exclusive_create(path: &Path, mode: u32) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    apply_mode(&mut options, mode);
    options.open(path)
}

fn mkdir_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(mode).create(path)
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        fs::create_dir(path)
    }
}

fn apply_mode(options: &mut OpenOptions, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    {
        let _ = (options, mode);
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let suffix = format!("{:x}{:x}", std::process::id(), nanos);
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => path.with_file_name(format!("{name}.{suffix}.tmp")),
        None => path.with_extension(format!("{suffix}.tmp")),
    }
}
