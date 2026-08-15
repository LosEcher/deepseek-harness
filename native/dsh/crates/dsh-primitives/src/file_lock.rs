//! Cross-process writer lock matching `withFileLock` in dsh-atomic-write.
//!
//! The lock is a `create_new` sibling (`<file>.lock`). Readers stay lock-free
//! because commit is a rename. A contender never removes an existing lock.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use thiserror::Error;

/// Writer-lock protocol constants. Contention normally resolves within the
/// retry deadline; expiry fails the contender without guessing whether the
/// existing lock still has an owner.
const LOCK_RETRY_INITIAL: Duration = Duration::from_millis(20);
const LOCK_RETRY_MAX: Duration = Duration::from_millis(200);
const LOCK_TIMEOUT: Duration = Duration::from_millis(2_000);

/// Failure while acquiring or holding a writer lock.
#[derive(Debug, Error)]
pub enum FileLockError {
    /// Contenders did not observe a free lock before the deadline.
    #[error("atomic-write: timed out waiting for the writer lock at {0}")]
    TimedOut(PathBuf),
    /// Underlying I/O failure.
    #[error("atomic-write: {0}")]
    Io(#[from] io::Error),
}

/// Hold the writer lock for `path` around `operation`.
///
/// The parent directory must exist. The lock releases on both success and
/// failure of `operation`.
pub fn with_file_lock<T, F>(path: impl AsRef<Path>, operation: F) -> Result<T, FileLockError>
where
    F: FnOnce() -> T,
{
    let path = path.as_ref();
    let lock_path = lock_path(path);
    acquire(&lock_path)?;
    let result = operation();
    let _ = fs::remove_file(&lock_path);
    Ok(result)
}

fn acquire(lock_path: &Path) -> Result<(), FileLockError> {
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let mut delay = LOCK_RETRY_INITIAL;
    loop {
        match exclusive_lock(lock_path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(FileLockError::Io(error)),
        }
        if Instant::now() >= deadline {
            return Err(FileLockError::TimedOut(lock_path.to_path_buf()));
        }
        thread::sleep(delay);
        delay = delay.saturating_mul(2).min(LOCK_RETRY_MAX);
    }
}

fn exclusive_lock(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_os_string();
    lock.push(".lock");
    PathBuf::from(lock)
}
