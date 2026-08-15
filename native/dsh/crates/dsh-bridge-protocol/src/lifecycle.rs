use crate::BridgeId;
use std::collections::{HashMap, HashSet};
use thiserror::Error;

/// Local lifecycle failures that must be surfaced instead of silently recovered.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LifecycleError {
    #[error("bridge is quiescing")]
    Quiescing,
    #[error("identifier is already registered")]
    Duplicate,
    #[error("identifier is not registered")]
    Unknown,
    #[error("identifier belongs to another connection generation")]
    GenerationMismatch,
    #[error("stream is already terminal")]
    Terminal,
    #[error("stream sequence {actual} was expected to be {expected}")]
    Sequence { actual: u64, expected: u64 },
    #[error("stream credit exhausted: requested {requested}, available {available}")]
    Credit { requested: usize, available: usize },
    #[error("stream credit overflow")]
    CreditOverflow,
    #[error("no in-flight operation can be completed")]
    NoInFlight,
}

struct ResourceRecord {
    generation: u64,
    resource_type: String,
}

/// Tracks handles and releases them by owner generation on disconnect.
#[derive(Default)]
pub struct ResourceRegistry {
    resources: HashMap<BridgeId, ResourceRecord>,
}

impl ResourceRegistry {
    /// Registers a new owner-bound resource handle.
    pub fn open(
        &mut self,
        generation: u64,
        id: BridgeId,
        resource_type: impl Into<String>,
    ) -> Result<(), LifecycleError> {
        if self.resources.contains_key(&id) {
            return Err(LifecycleError::Duplicate);
        }
        self.resources.insert(
            id,
            ResourceRecord {
                generation,
                resource_type: resource_type.into(),
            },
        );
        Ok(())
    }

    /// Releases a handle only when the caller owns its generation.
    pub fn release(&mut self, generation: u64, id: &BridgeId) -> Result<(), LifecycleError> {
        let record = self.resources.get(id).ok_or(LifecycleError::Unknown)?;
        if record.generation != generation {
            return Err(LifecycleError::GenerationMismatch);
        }
        self.resources.remove(id);
        Ok(())
    }

    /// Releases every handle owned by a dead connection generation.
    pub fn release_generation(&mut self, generation: u64) -> usize {
        let before = self.resources.len();
        self.resources
            .retain(|_, record| record.generation != generation);
        before - self.resources.len()
    }

    /// Returns the registered resource count.
    pub fn len(&self) -> usize {
        self.resources.len()
    }

    /// Returns whether no resource is registered.
    pub fn is_empty(&self) -> bool {
        self.resources.is_empty()
    }

    /// Returns the registered resource type for diagnostics and tests.
    pub fn resource_type(&self, id: &BridgeId) -> Option<&str> {
        self.resources
            .get(id)
            .map(|record| record.resource_type.as_str())
    }
}

/// Enforces ordered chunks, bounded buffering, and one terminal frame per stream.
pub struct StreamState {
    generation: u64,
    id: BridgeId,
    next_sequence: u64,
    credit_bytes: usize,
    terminal: bool,
}

impl StreamState {
    /// Creates a stream with receiver-granted byte credit.
    pub fn new(generation: u64, id: BridgeId, credit_bytes: usize) -> Self {
        Self {
            generation,
            id,
            next_sequence: 0,
            credit_bytes,
            terminal: false,
        }
    }

    /// Accepts one ordered chunk and consumes its receiver credit.
    pub fn accept_chunk(
        &mut self,
        generation: u64,
        id: &BridgeId,
        sequence: u64,
        bytes: usize,
    ) -> Result<(), LifecycleError> {
        self.check_owner(generation, id)?;
        if self.terminal {
            return Err(LifecycleError::Terminal);
        }
        if sequence != self.next_sequence {
            return Err(LifecycleError::Sequence {
                actual: sequence,
                expected: self.next_sequence,
            });
        }
        if bytes > self.credit_bytes {
            return Err(LifecycleError::Credit {
                requested: bytes,
                available: self.credit_bytes,
            });
        }
        self.credit_bytes -= bytes;
        self.next_sequence += 1;
        Ok(())
    }

    /// Grants additional receiver credit.
    pub fn grant(
        &mut self,
        generation: u64,
        id: &BridgeId,
        bytes: usize,
    ) -> Result<(), LifecycleError> {
        self.check_owner(generation, id)?;
        if self.terminal {
            return Err(LifecycleError::Terminal);
        }
        self.credit_bytes = self
            .credit_bytes
            .checked_add(bytes)
            .ok_or(LifecycleError::CreditOverflow)?;
        Ok(())
    }

    /// Marks the stream terminal exactly once.
    pub fn finish(&mut self, generation: u64, id: &BridgeId) -> Result<(), LifecycleError> {
        self.check_owner(generation, id)?;
        if self.terminal {
            return Err(LifecycleError::Terminal);
        }
        self.terminal = true;
        Ok(())
    }

    /// Returns whether a terminal frame has been accepted.
    pub fn is_terminal(&self) -> bool {
        self.terminal
    }

    fn check_owner(&self, generation: u64, id: &BridgeId) -> Result<(), LifecycleError> {
        if self.generation != generation || self.id != *id {
            return Err(LifecycleError::GenerationMismatch);
        }
        Ok(())
    }
}

/// One-shot waterfall continuation registry scoped to a connection generation.
#[derive(Default)]
pub struct ContinuationRegistry {
    pending: HashMap<BridgeId, u64>,
}

impl ContinuationRegistry {
    /// Registers a continuation id.
    pub fn register(&mut self, generation: u64, id: BridgeId) -> Result<(), LifecycleError> {
        if self.pending.contains_key(&id) {
            return Err(LifecycleError::Duplicate);
        }
        self.pending.insert(id, generation);
        Ok(())
    }

    /// Takes a continuation exactly once for the owning generation.
    pub fn take(&mut self, generation: u64, id: &BridgeId) -> Result<(), LifecycleError> {
        let owner = self.pending.get(id).ok_or(LifecycleError::Unknown)?;
        if *owner != generation {
            return Err(LifecycleError::GenerationMismatch);
        }
        self.pending.remove(id);
        Ok(())
    }

    /// Removes continuations owned by a dead generation.
    pub fn clear_generation(&mut self, generation: u64) -> usize {
        let ids: HashSet<BridgeId> = self
            .pending
            .iter()
            .filter(|(_, owner)| **owner == generation)
            .map(|(id, _)| id.clone())
            .collect();
        let count = ids.len();
        for id in ids {
            self.pending.remove(&id);
        }
        count
    }

    /// Returns the number of continuations awaiting a downstream reply.
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Returns whether no continuation is pending.
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// Tracks work and owned resources during dispose/quiescence.
#[derive(Default)]
pub struct BridgeLifecycle {
    quiescing: bool,
    in_flight: usize,
    resources: ResourceRegistry,
    continuations: ContinuationRegistry,
    streams: HashMap<BridgeId, StreamState>,
}

impl BridgeLifecycle {
    /// Allows a new operation while disposal has not started.
    pub fn begin_work(&mut self) -> Result<(), LifecycleError> {
        if self.quiescing {
            return Err(LifecycleError::Quiescing);
        }
        self.in_flight += 1;
        Ok(())
    }

    /// Completes one operation previously accepted by `begin_work`.
    pub fn end_work(&mut self) -> Result<(), LifecycleError> {
        if self.in_flight == 0 {
            return Err(LifecycleError::NoInFlight);
        }
        self.in_flight -= 1;
        Ok(())
    }

    /// Starts disposal and rejects new work.
    pub fn dispose(&mut self) {
        self.quiescing = true;
    }

    /// Reports whether all owned work has drained.
    pub fn is_quiescent(&self) -> bool {
        self.quiescing
            && self.in_flight == 0
            && self.resources.is_empty()
            && self.continuations.is_empty()
            && self.streams.is_empty()
    }

    /// Opens a resource while the connection accepts new work.
    pub fn open_resource(
        &mut self,
        generation: u64,
        id: BridgeId,
        resource_type: impl Into<String>,
    ) -> Result<(), LifecycleError> {
        self.ensure_accepting()?;
        self.resources.open(generation, id, resource_type)
    }

    /// Releases a resource owned by the specified generation.
    pub fn release_resource(
        &mut self,
        generation: u64,
        id: &BridgeId,
    ) -> Result<(), LifecycleError> {
        self.resources.release(generation, id)
    }

    /// Registers a one-shot continuation while the connection accepts new work.
    pub fn register_continuation(
        &mut self,
        generation: u64,
        id: BridgeId,
    ) -> Result<(), LifecycleError> {
        self.ensure_accepting()?;
        self.continuations.register(generation, id)
    }

    /// Takes a continuation for one downstream invocation.
    pub fn take_continuation(
        &mut self,
        generation: u64,
        id: &BridgeId,
    ) -> Result<(), LifecycleError> {
        self.continuations.take(generation, id)
    }

    /// Opens a credit-controlled stream while the connection accepts new work.
    pub fn open_stream(
        &mut self,
        generation: u64,
        id: BridgeId,
        credit_bytes: usize,
    ) -> Result<(), LifecycleError> {
        self.ensure_accepting()?;
        if self.streams.contains_key(&id) {
            return Err(LifecycleError::Duplicate);
        }
        self.streams
            .insert(id.clone(), StreamState::new(generation, id, credit_bytes));
        Ok(())
    }

    /// Accepts one chunk for an active stream.
    pub fn accept_stream_chunk(
        &mut self,
        generation: u64,
        id: &BridgeId,
        sequence: u64,
        bytes: usize,
    ) -> Result<(), LifecycleError> {
        self.streams
            .get_mut(id)
            .ok_or(LifecycleError::Unknown)?
            .accept_chunk(generation, id, sequence, bytes)
    }

    /// Grants receiver credit to an active stream.
    pub fn grant_stream_credit(
        &mut self,
        generation: u64,
        id: &BridgeId,
        bytes: usize,
    ) -> Result<(), LifecycleError> {
        self.streams
            .get_mut(id)
            .ok_or(LifecycleError::Unknown)?
            .grant(generation, id, bytes)
    }

    /// Accepts one terminal frame and removes the active stream.
    pub fn finish_stream(&mut self, generation: u64, id: &BridgeId) -> Result<(), LifecycleError> {
        self.streams
            .get_mut(id)
            .ok_or(LifecycleError::Unknown)?
            .finish(generation, id)?;
        self.streams.remove(id);
        Ok(())
    }

    /// Releases all connection-owned state after disconnect or forced cancellation.
    pub fn release_generation(&mut self, generation: u64) {
        self.resources.release_generation(generation);
        self.continuations.clear_generation(generation);
        self.streams
            .retain(|_, stream| stream.generation != generation);
    }

    fn ensure_accepting(&self) -> Result<(), LifecycleError> {
        if self.quiescing {
            return Err(LifecycleError::Quiescing);
        }
        Ok(())
    }
}
