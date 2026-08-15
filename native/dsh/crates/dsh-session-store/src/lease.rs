//! Exclusive session lease: one live writer per session id.
//!
//! The lease is a `create_new` file under the session directory. A second
//! acquirer receives [`SessionLeaseError::AlreadyHeld`] and does not replace
//! the holder. Drop and [`SessionLease::release`] remove the file so a later
//! writer may acquire.

use dsh_primitives::{Brand, Branded};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;

/// Brand for a durable session id.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SessionIdBrand;

impl Brand for SessionIdBrand {
    const NAME: &'static str = "SessionId";
}

/// Opaque session identity carried on the lease.
pub type SessionId = Branded<SessionIdBrand>;

/// Record written into the lease file so a refused acquirer can name the holder.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LeaseRecord {
    /// Unique owner token for this acquisition.
    pub owner: String,
    /// Process that created the lease.
    pub pid: u32,
    /// Unix epoch milliseconds when the lease was acquired.
    pub acquired_at_ms: u128,
}

/// Failure while acquiring or releasing a session lease.
#[derive(Debug, Error)]
pub enum SessionLeaseError {
    /// Another writer already holds this session.
    #[error("session-lease: session {session_id} is already held by {owner}")]
    AlreadyHeld {
        /// Session that refused the second writer.
        session_id: String,
        /// Owner token recorded by the current holder.
        owner: String,
    },
    /// Underlying I/O failure.
    #[error("session-lease: {0}")]
    Io(#[from] io::Error),
}

/// Exclusive lease for one session id.
#[derive(Debug)]
pub struct SessionLease {
    path: PathBuf,
    session_id: SessionId,
    record: LeaseRecord,
    released: bool,
}

impl SessionLease {
    /// Acquire an exclusive lease for `session_id` under `dir`.
    ///
    /// `dir` is created when missing. A second concurrent acquirer fails with
    /// [`SessionLeaseError::AlreadyHeld`] and does not become a writer.
    pub fn acquire(
        dir: impl AsRef<Path>,
        session_id: SessionId,
    ) -> Result<Self, SessionLeaseError> {
        let dir = dir.as_ref();
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("{}.lease", session_id.as_str()));
        let record = LeaseRecord {
            owner: owner_token(),
            pid: std::process::id(),
            acquired_at_ms: now_ms(),
        };
        match exclusive_create(&path) {
            Ok(mut file) => {
                let payload = serde_json::to_vec(&record).map_err(json_io)?;
                file.write_all(&payload)?;
                file.write_all(b"\n")?;
                Ok(Self {
                    path,
                    session_id,
                    record,
                    released: false,
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(SessionLeaseError::AlreadyHeld {
                    session_id: session_id.into_inner(),
                    owner: read_owner(&path),
                })
            }
            Err(error) => Err(SessionLeaseError::Io(error)),
        }
    }

    /// Session this lease owns.
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// Owner token recorded at acquire time.
    pub fn owner(&self) -> &str {
        &self.record.owner
    }

    /// Release the lease so another writer may acquire this session.
    pub fn release(mut self) -> Result<(), SessionLeaseError> {
        self.clear()
    }

    fn clear(&mut self) -> Result<(), SessionLeaseError> {
        if self.released {
            return Ok(());
        }
        fs::remove_file(&self.path)?;
        self.released = true;
        Ok(())
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        let _ = self.clear();
    }
}

fn exclusive_create(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn read_owner(path: &Path) -> String {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<LeaseRecord>(text.trim()).ok())
        .map(|record| record.owner)
        .unwrap_or_else(|| "unknown".to_string())
}

fn owner_token() -> String {
    format!("{:x}-{:x}", std::process::id(), now_ms())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn json_io(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}
