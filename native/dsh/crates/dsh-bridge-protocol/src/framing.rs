use crate::BridgeMessage;
use serde_json::Error as JsonError;
use std::io::Write;
use thiserror::Error;

/// Errors raised while decoding or writing Content-Length frames.
#[derive(Debug, Error)]
pub enum FrameError {
    #[error("frame header is not valid UTF-8")]
    HeaderEncoding,
    #[error("frame header is missing Content-Length")]
    MissingContentLength,
    #[error("frame header contains more than one Content-Length")]
    DuplicateContentLength,
    #[error("frame header exceeds the 4096 byte limit")]
    HeaderTooLarge,
    #[error("frame Content-Length is invalid")]
    InvalidContentLength,
    #[error("frame exceeds the {max} byte limit")]
    TooLarge { max: usize },
    #[error("frame JSON is invalid: {0}")]
    Json(#[from] JsonError),
    #[error("frame write failed: {0}")]
    Io(#[from] std::io::Error),
}

/// Default maximum logical frame size for the temporary JSON carrier.
pub const DEFAULT_MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

/// Encodes one message using the LSP-compatible Content-Length carrier.
pub fn encode_frame(message: &BridgeMessage) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(message).map_err(FrameError::Json)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut frame = Vec::with_capacity(header.len() + body.len());
    frame.extend_from_slice(header.as_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Writes one encoded frame without mixing diagnostics into stdout.
pub fn write_frame<W: Write>(writer: &mut W, message: &BridgeMessage) -> Result<(), FrameError> {
    writer.write_all(&encode_frame(message)?)?;
    writer.flush()?;
    Ok(())
}

/// Incremental decoder that accepts arbitrary transport chunk boundaries.
pub struct FrameDecoder {
    buffer: Vec<u8>,
    max_frame_size: usize,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_FRAME_SIZE)
    }
}

impl FrameDecoder {
    /// Creates a decoder with an explicit body-size limit.
    pub fn new(max_frame_size: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_size,
        }
    }

    /// Adds bytes and returns every complete message currently available.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<BridgeMessage>, FrameError> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();
        loop {
            let Some(separator) = self
                .buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
            else {
                if self.buffer.len() > 4096 {
                    return Err(FrameError::HeaderTooLarge);
                }
                break;
            };
            if separator > 4096 {
                return Err(FrameError::HeaderTooLarge);
            }
            let header = std::str::from_utf8(&self.buffer[..separator])
                .map_err(|_| FrameError::HeaderEncoding)?;
            let content_length = parse_content_length(header)?;
            if content_length > self.max_frame_size {
                return Err(FrameError::TooLarge {
                    max: self.max_frame_size,
                });
            }
            let body_start = separator + 4;
            let frame_end = body_start + content_length;
            if self.buffer.len() < frame_end {
                break;
            }
            let body: Vec<u8> = self.buffer[body_start..frame_end].to_vec();
            self.buffer.drain(..frame_end);
            messages.push(serde_json::from_slice(&body)?);
        }
        Ok(messages)
    }

    /// Returns the number of bytes waiting for a complete frame.
    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }
}

fn parse_content_length(header: &str) -> Result<usize, FrameError> {
    let mut parsed = None;
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            if parsed.is_some() {
                return Err(FrameError::DuplicateContentLength);
            }
            parsed = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| FrameError::InvalidContentLength)?,
            );
        }
    }
    parsed.ok_or(FrameError::MissingContentLength)
}
