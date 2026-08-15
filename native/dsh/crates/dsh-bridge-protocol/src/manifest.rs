use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Generated P0 bridge manifest fixture consumed by Rust conformance tests.
pub const BRIDGE_MANIFEST: &str = include_str!("../../../contracts/bridge-manifest.json");

const MANIFEST_SOURCE: &str = include_str!("../../../contracts/bridge-manifest-source.json");

/// Returns the digest string expected in the generated manifest.
pub fn manifest_source_digest() -> String {
    format!("sha256:{}", hex_digest(MANIFEST_SOURCE.as_bytes()))
}

/// Checks the checked-in fixture's version and source digest.
pub fn verify_manifest() -> Result<(), ManifestError> {
    let manifest: Value = serde_json::from_str(BRIDGE_MANIFEST)?;
    let object = manifest.as_object().ok_or(ManifestError::NotObject)?;
    let version = object
        .get("format_version")
        .and_then(Value::as_u64)
        .ok_or(ManifestError::MissingVersion)?;
    if version != 1 {
        return Err(ManifestError::UnsupportedVersion(version));
    }
    let expected = manifest_source_digest();
    let actual = object
        .get("source_digest")
        .and_then(Value::as_str)
        .ok_or(ManifestError::MissingDigest)?;
    if actual != expected {
        return Err(ManifestError::DigestMismatch {
            expected,
            actual: actual.to_owned(),
        });
    }
    Ok(())
}

/// Manifest validation failures.
#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("manifest JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("manifest root must be an object")]
    NotObject,
    #[error("manifest format_version is missing")]
    MissingVersion,
    #[error("manifest format_version {0} is unsupported")]
    UnsupportedVersion(u64),
    #[error("manifest source_digest is missing")]
    MissingDigest,
    #[error("manifest source digest mismatch: expected {expected}, got {actual}")]
    DigestMismatch { expected: String, actual: String },
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
