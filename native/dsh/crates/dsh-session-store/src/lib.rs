//! Session persistence primitives for P2: exclusive leases and JSONL append.
//!
//! A second writer cannot acquire a live session. TypeScript coordinators
//! remain authoritative until a facade is allow-listed.

mod jsonl;
mod lease;

pub use jsonl::{append_jsonl, read_jsonl, JsonlError};
pub use lease::{SessionId, SessionLease, SessionLeaseError};
