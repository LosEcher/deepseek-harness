//! Append-only JSONL rows for a session log.

use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;

use thiserror::Error;

/// Failure while appending or reading a JSONL log.
#[derive(Debug, Error)]
pub enum JsonlError {
    /// A stored line is not valid JSON.
    #[error("jsonl: invalid JSON on line {line}: {source}")]
    InvalidJson {
        /// 1-based line number in the file.
        line: usize,
        /// Parse failure for that line.
        #[source]
        source: serde_json::Error,
    },
    /// Underlying I/O failure.
    #[error("jsonl: {0}")]
    Io(#[from] io::Error),
}

/// Append one JSON value as a single line, creating parent directories.
pub fn append_jsonl(path: impl AsRef<Path>, value: &Value) -> Result<(), JsonlError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let mut line = serde_json::to_vec(value).map_err(json_io)?;
    line.push(b'\n');
    file.write_all(&line)?;
    Ok(())
}

/// Read every JSON line from `path`. A missing file is an empty log.
pub fn read_jsonl(path: impl AsRef<Path>) -> Result<Vec<Value>, JsonlError> {
    let path = path.as_ref();
    let file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(JsonlError::Io(error)),
    };
    let mut values = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let value = serde_json::from_str(&line).map_err(|source| JsonlError::InvalidJson {
            line: index + 1,
            source,
        })?;
        values.push(value);
    }
    Ok(values)
}

fn json_io(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}
