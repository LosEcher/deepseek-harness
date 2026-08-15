//! Filesystem capability service for the migration bridge.
//!
//! This is the P1 execution-world prototype: `fs.resolve` and text reads over
//! the bridge, including alias identity, missing targets, cancellation, and
//! atomic mutation inside an isolated directory.

use dsh_bridge_runtime::{CallContext, Service, ServiceError};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Stable error codes exposed by the filesystem service.
pub mod codes {
    /// Target path does not exist.
    pub const NOT_FOUND: &str = "fs.not_found";
    /// Target is not a regular file.
    pub const NOT_A_FILE: &str = "fs.not_a_file";
    /// Content is not valid UTF-8 text.
    pub const NOT_TEXT: &str = "fs.not_text";
    /// Underlying I/O failure.
    pub const IO: &str = "fs.io";
}

/// The `fs` bridge service (P1 prototype scope).
#[derive(Debug, Default)]
pub struct FsService;

impl FsService {
    /// Creates the service.
    pub fn new() -> Self {
        Self
    }

    /// `resolve(path)` -> `{ path, identity }`
    ///
    /// Resolves symlinks and returns a stable identity for the target. Two
    /// paths that alias the same file (hard link, symlink) yield the same
    /// identity.
    fn resolve(&self, args: &Value) -> Result<Value, ServiceError> {
        let path = path_arg(args, "path")?;
        let canonical = fs::canonicalize(&path).map_err(|error| io_error(&path, error))?;
        let identity = file_identity(&canonical).map_err(|error| io_error(&canonical, error))?;
        Ok(json!({
            "path": canonical.to_string_lossy(),
            "identity": identity,
        }))
    }

    /// `readText(path)` -> `{ text, identity }`
    ///
    /// Reads a UTF-8 text file with cancellation checked between chunks.
    fn read_text(&self, args: &Value, ctx: &CallContext) -> Result<Value, ServiceError> {
        let path = path_arg(args, "path")?;
        let mut file = OpenOptions::new()
            .read(true)
            .open(&path)
            .map_err(|error| io_error(&path, error))?;
        let metadata = file.metadata().map_err(|error| io_error(&path, error))?;
        if !metadata.is_file() {
            return Err(ServiceError::new(
                codes::NOT_A_FILE,
                format!("{:?} is not a regular file", path),
            ));
        }
        let identity = file_identity(&path).map_err(|error| io_error(&path, error))?;
        let mut text = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            if ctx.is_cancelled() {
                return Err(ServiceError::cancelled());
            }
            let read = file
                .read(&mut buffer)
                .map_err(|error| io_error(&path, error))?;
            if read == 0 {
                break;
            }
            text.extend_from_slice(&buffer[..read]);
        }
        let text = String::from_utf8(text).map_err(|_| {
            ServiceError::new(
                codes::NOT_TEXT,
                format!("{:?} is not valid UTF-8 text", path),
            )
        })?;
        Ok(json!({
            "text": text,
            "identity": identity,
        }))
    }

    /// `writeTextAtomic(path, text)` -> `{ path }`
    ///
    /// Writes text to a temporary sibling file, syncs it, then renames over
    /// the target: readers never observe a partially written file. The
    /// temporary file is removed on failure.
    fn write_text_atomic(&self, args: &Value) -> Result<Value, ServiceError> {
        let path = path_arg(args, "path")?;
        let text = args
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceError::new("fs.bad_args", "missing string arg `text`"))?;
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let file_name = path.file_name().ok_or_else(|| {
            ServiceError::new(codes::NOT_A_FILE, format!("{:?} has no file name", path))
        })?;
        let mut temporary = parent.join(format!(
            ".{}.dsh-tmp-{}",
            file_name.to_string_lossy(),
            std::process::id()
        ));
        // Make concurrent writers collision-safe by appending a counter.
        for suffix in 0..100u32 {
            let candidate = parent.join(format!(
                ".{}.dsh-tmp-{}-{}",
                file_name.to_string_lossy(),
                std::process::id(),
                suffix
            ));
            if !candidate.exists() {
                temporary = candidate;
                break;
            }
        }
        let result = (|| -> Result<(), ServiceError> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| io_error(&temporary, error))?;
            file.write_all(text.as_bytes())
                .map_err(|error| io_error(&temporary, error))?;
            file.sync_all()
                .map_err(|error| io_error(&temporary, error))?;
            fs::rename(&temporary, &path).map_err(|error| io_error(&path, error))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(json!({ "path": path.to_string_lossy() }))
    }
}

impl Service for FsService {
    fn service_name(&self) -> &str {
        "fs"
    }

    fn call(&self, method: &str, args: &Value, ctx: &CallContext) -> Result<Value, ServiceError> {
        match method {
            "resolve" => self.resolve(args),
            "readText" => self.read_text(args, ctx),
            "writeTextAtomic" => self.write_text_atomic(args),
            other => Err(ServiceError::new(
                "bridge.no_method",
                format!("fs.{other} is not served in this migration phase"),
            )),
        }
    }
}

fn path_arg(args: &Value, key: &str) -> Result<PathBuf, ServiceError> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ServiceError::new("fs.bad_args", format!("missing string arg `{key}`")))?;
    Ok(PathBuf::from(value))
}

/// Stable identity for a file: device + inode where available.
#[cfg(unix)]
fn file_identity(path: &Path) -> std::io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path)?;
    Ok(format!("dev:{}:ino:{}", metadata.dev(), metadata.ino()))
}

/// Non-unix fallback: canonical path is the identity.
#[cfg(not(unix))]
fn file_identity(path: &Path) -> std::io::Result<String> {
    Ok(fs::canonicalize(path)?.to_string_lossy().into_owned())
}

fn io_error(path: &Path, error: std::io::Error) -> ServiceError {
    let code = if error.kind() == std::io::ErrorKind::NotFound {
        codes::NOT_FOUND
    } else {
        codes::IO
    };
    ServiceError::new(code, format!("{:?}: {error}", path)).with_data(json!({
        "path": path.to_string_lossy(),
        "os_error": error.raw_os_error(),
    }))
}
