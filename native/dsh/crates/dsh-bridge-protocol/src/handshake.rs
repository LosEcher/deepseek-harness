use thiserror::Error;

/// Protocol version for the first migration bridge.
pub const PROTOCOL_VERSION: u16 = 1;

/// Process role used during the Node-root and Rust-root migration phases.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeRole {
    NodeRoot,
    RustSidecar,
    RustRoot,
    JsGuest,
}

impl BridgeRole {
    /// Returns whether two roles are a supported root/guest pairing.
    pub fn can_pair_with(self, peer: Self) -> bool {
        matches!(
            (self, peer),
            (Self::NodeRoot, Self::RustSidecar)
                | (Self::RustSidecar, Self::NodeRoot)
                | (Self::RustRoot, Self::JsGuest)
                | (Self::JsGuest, Self::RustRoot)
        )
    }
}

/// Hello payload exchanged before any service registration.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Hello {
    /// Bridge protocol version.
    pub bridge_version: u16,
    /// Connection generation, never reused after a disconnect.
    pub generation: u64,
    /// Role of the sending process.
    pub role: BridgeRole,
    /// Human-readable build identifier for diagnostics.
    pub build: String,
    /// Digest of the generated contract manifest.
    pub schema_digest: String,
    /// Optional capabilities advertised by the sender.
    pub capabilities: Vec<String>,
}

/// Handshake failures that make the provider unavailable.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum HandshakeError {
    #[error("unsupported bridge version {actual}, expected {expected}")]
    Version { actual: u16, expected: u16 },
    #[error("bridge generation must be non-zero")]
    ZeroGeneration,
    #[error("bridge generation mismatch: local {local}, peer {peer}")]
    Generation { local: u64, peer: u64 },
    #[error("bridge roles {local:?} and {peer:?} cannot pair")]
    Role { local: BridgeRole, peer: BridgeRole },
    #[error("bridge schema digest mismatch: local {local}, peer {peer}")]
    SchemaDigest { local: String, peer: String },
    #[error("bridge build identifier is empty")]
    EmptyBuild,
    #[error("bridge capability is empty")]
    EmptyCapability,
    #[error("bridge capability {0} is duplicated")]
    DuplicateCapability(String),
    #[error("bridge peer does not support required capability {0}")]
    MissingCapability(String),
}

impl Hello {
    /// Validates a peer hello against local version, role, and schema expectations.
    pub fn validate_peer(
        &self,
        peer: &Self,
        expected_schema_digest: &str,
        required_capabilities: &[&str],
    ) -> Result<(), HandshakeError> {
        if peer.bridge_version != PROTOCOL_VERSION {
            return Err(HandshakeError::Version {
                actual: peer.bridge_version,
                expected: PROTOCOL_VERSION,
            });
        }
        if self.generation == 0 || peer.generation == 0 {
            return Err(HandshakeError::ZeroGeneration);
        }
        if self.generation != peer.generation {
            return Err(HandshakeError::Generation {
                local: self.generation,
                peer: peer.generation,
            });
        }
        if peer.build.trim().is_empty() {
            return Err(HandshakeError::EmptyBuild);
        }
        if !self.role.can_pair_with(peer.role) {
            return Err(HandshakeError::Role {
                local: self.role,
                peer: peer.role,
            });
        }
        if peer.schema_digest != expected_schema_digest {
            return Err(HandshakeError::SchemaDigest {
                local: expected_schema_digest.to_owned(),
                peer: peer.schema_digest.clone(),
            });
        }
        let mut capabilities = std::collections::HashSet::new();
        for capability in &peer.capabilities {
            if capability.trim().is_empty() {
                return Err(HandshakeError::EmptyCapability);
            }
            if !capabilities.insert(capability.as_str()) {
                return Err(HandshakeError::DuplicateCapability(capability.clone()));
            }
        }
        for required in required_capabilities {
            if !capabilities.contains(required) {
                return Err(HandshakeError::MissingCapability((*required).to_owned()));
            }
        }
        Ok(())
    }
}
