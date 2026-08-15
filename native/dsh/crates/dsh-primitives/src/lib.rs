//! Leaf filesystem and identity primitives shared by later P2 stores.
//!
//! These types have no Cordis or bridge dependency. TypeScript coordinators
//! stay on the Node implementations until a facade is allow-listed.

mod atomic_write;
mod brand;
mod file_lock;

pub use atomic_write::{write_file_atomic, AtomicWriteError, WriteFileAtomicOptions};
pub use brand::{Brand, Branded};
pub use file_lock::{with_file_lock, FileLockError};
