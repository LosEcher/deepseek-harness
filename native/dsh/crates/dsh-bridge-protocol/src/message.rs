use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// Opaque identifier owned by one bridge connection generation.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BridgeId(String);

impl BridgeId {
    /// Creates an identifier and rejects an empty or whitespace-only value.
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err("bridge identifiers must not be empty");
        }
        Ok(Self(value))
    }

    /// Returns the wire representation.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for BridgeId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(D::Error::custom)
    }
}

/// Stable error data carried by a reply or terminal stream frame.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RemoteError {
    /// Machine-readable error identity.
    pub code: String,
    /// Public message, when the protocol defines one.
    pub message: String,
    /// Whether retrying the same operation may succeed.
    pub retryable: bool,
    /// Whether cancellation caused the failure.
    pub cancelled: bool,
    /// Structured details that are safe for the receiving side to inspect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Event dispatch semantics preserved across the bridge.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchMode {
    Emit,
    Serial,
    Parallel,
    Waterfall,
}

/// Logical messages exchanged by both bridge roles.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum BridgeMessage {
    Hello(crate::Hello),
    Call {
        generation: u64,
        id: BridgeId,
        service: String,
        method: String,
        args: Value,
    },
    Reply {
        generation: u64,
        id: BridgeId,
        result: Value,
    },
    Error {
        generation: u64,
        id: BridgeId,
        error: RemoteError,
    },
    Cancel {
        generation: u64,
        id: BridgeId,
    },
    ResourceOpen {
        generation: u64,
        id: BridgeId,
        resource_type: String,
    },
    ResourceRelease {
        generation: u64,
        id: BridgeId,
    },
    StreamOpen {
        generation: u64,
        id: BridgeId,
        resource_type: String,
        credit_bytes: u32,
    },
    StreamChunk {
        generation: u64,
        id: BridgeId,
        sequence: u64,
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,
    },
    StreamCredit {
        generation: u64,
        id: BridgeId,
        credit_bytes: u32,
    },
    StreamEnd {
        generation: u64,
        id: BridgeId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RemoteError>,
    },
    ContributionRegister {
        generation: u64,
        id: BridgeId,
        plugin: String,
        service: String,
    },
    ContributionRemove {
        generation: u64,
        id: BridgeId,
        plugin: String,
    },
    EventInvoke {
        generation: u64,
        id: BridgeId,
        event: String,
        payload: Value,
        dispatch: DispatchMode,
    },
    ContinuationCall {
        generation: u64,
        id: BridgeId,
        payload: Value,
    },
    ContinuationReply {
        generation: u64,
        id: BridgeId,
        payload: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RemoteError>,
    },
    Dispose {
        generation: u64,
    },
    Quiescent {
        generation: u64,
    },
}

mod base64_bytes {
    use super::*;

    pub fn serialize<S>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&BASE64.encode(value))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        BASE64.decode(encoded).map_err(D::Error::custom)
    }
}
