use crate::error::{RuntimeError, SideExit};
use crate::service::{CallContext, ContinuationMessage, FrameSink, Service, ServiceError};
use dsh_bridge_protocol::{
    manifest_source_digest, BridgeId, BridgeLifecycle, BridgeMessage, FrameDecoder, Hello,
    RemoteError,
};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// Connection configuration shared by both bridge roles.
#[derive(Clone)]
pub struct BridgeConfig {
    /// Local hello payload; its role decides how the peer is validated.
    pub hello: Hello,
    /// Capabilities the peer must advertise for the connection to proceed.
    pub required_peer_capabilities: Vec<String>,
    /// Registered capability services.
    pub services: Arc<dyn ServiceRegistry>,
    /// Maximum logical frame size accepted from the peer.
    pub max_frame_size: usize,
}

/// Registry of services addressable by `service` name.
pub trait ServiceRegistry: Send + Sync {
    /// Resolves a service by its registered name.
    fn resolve(&self, name: &str) -> Option<Arc<dyn Service>>;

    /// Returns every registered service, for id-ownership routing.
    fn all(&self) -> Vec<Arc<dyn Service>>;
}

/// Simple fixed map registry for the first-party sidecar.
#[derive(Default)]
pub struct MapRegistry {
    services: Mutex<HashMap<String, Arc<dyn Service>>>,
}

impl MapRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one service under its service name.
    pub fn register(&self, service: Arc<dyn Service>) {
        self.services
            .lock()
            .expect("registry lock must not poison")
            .insert(service.service_name().to_owned(), service);
    }
}

impl ServiceRegistry for MapRegistry {
    fn resolve(&self, name: &str) -> Option<Arc<dyn Service>> {
        self.services
            .lock()
            .expect("registry lock must not poison")
            .get(name)
            .cloned()
    }

    fn all(&self) -> Vec<Arc<dyn Service>> {
        self.services
            .lock()
            .expect("registry lock must not poison")
            .values()
            .cloned()
            .collect()
    }
}

/// Runs one bridge connection to completion.
///
/// `reader`/`writer` are the stdio streams (or pipes in tests). The function
/// returns `Ok(SideExit::Quiescent)` after a clean `dispose` exchange, and
/// `Err` on any fast-fail condition (bad handshake, framing error, EOF
/// without dispose, protocol violation).
pub fn serve<R, W>(reader: R, writer: W, config: BridgeConfig) -> Result<SideExit, RuntimeError>
where
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    Connection::new(writer, config)?.run(reader)
}

struct Connection<W> {
    writer: Arc<Mutex<W>>,
    config: BridgeConfig,
    generation: u64,
    lifecycle: Arc<Mutex<BridgeLifecycle>>,
    pending: Arc<Mutex<HashMap<BridgeId, Arc<AtomicBool>>>>,
    /// One-shot waterfall continuations awaiting a peer frame.
    continuations: Arc<Mutex<HashMap<BridgeId, std::sync::mpsc::Sender<ContinuationMessage>>>>,
    workers: Vec<JoinHandle<()>>,
    handshake_done: bool,
}

/// Sink handed to services so worker threads can emit bridge frames.
struct WriterSink<W> {
    writer: Arc<Mutex<W>>,
    continuations: Arc<Mutex<HashMap<BridgeId, std::sync::mpsc::Sender<ContinuationMessage>>>>,
}

impl<W: Write + Send> FrameSink for WriterSink<W> {
    fn send(&self, message: BridgeMessage) -> Result<(), RuntimeError> {
        let mut writer = self.writer.lock().expect("writer lock must not poison");
        dsh_bridge_protocol::write_frame(&mut *writer, &message)?;
        Ok(())
    }

    fn open_continuation(&self, id: &BridgeId) -> std::sync::mpsc::Receiver<ContinuationMessage> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.continuations
            .lock()
            .expect("continuations lock must not poison")
            .insert(id.clone(), tx);
        rx
    }

    fn close_continuation(&self, id: &BridgeId) {
        self.continuations
            .lock()
            .expect("continuations lock must not poison")
            .remove(id);
    }
}

impl<W> Connection<W>
where
    W: Write + Send + 'static,
{
    fn new(writer: W, config: BridgeConfig) -> Result<Self, RuntimeError> {
        if config.hello.generation == 0 {
            return Err(RuntimeError::Handshake(
                dsh_bridge_protocol::HandshakeError::ZeroGeneration,
            ));
        }
        let generation = config.hello.generation;
        Ok(Self {
            writer: Arc::new(Mutex::new(writer)),
            config,
            generation,
            lifecycle: Arc::new(Mutex::new(BridgeLifecycle::default())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            continuations: Arc::new(Mutex::new(HashMap::new())),
            workers: Vec::new(),
            handshake_done: false,
        })
    }

    fn write(&self, message: &BridgeMessage) -> Result<(), RuntimeError> {
        let mut writer = self.writer.lock().expect("writer lock must not poison");
        dsh_bridge_protocol::write_frame(&mut *writer, message)?;
        Ok(())
    }

    fn sink(&self) -> Arc<dyn FrameSink> {
        Arc::new(WriterSink {
            writer: Arc::clone(&self.writer),
            continuations: Arc::clone(&self.continuations),
        })
    }

    fn run<R>(mut self, reader: R) -> Result<SideExit, RuntimeError>
    where
        R: Read + Send + 'static,
    {
        // 1. Send our hello first, then expect the peer's hello before any
        //    other message. A mismatch rejects the connection fast.
        self.write(&BridgeMessage::Hello(self.config.hello.clone()))?;

        let (tx, rx) = mpsc::channel();
        let _reader_thread = spawn_reader(reader, tx, self.config.max_frame_size);

        loop {
            let message = match rx.recv() {
                Ok(Ok(message)) => message,
                Ok(Err(error)) => return Err(error),
                Err(_) => {
                    // Reader thread died (EOF reported on the channel);
                    // without a dispose this is abnormal.
                    self.reject_pending("peer closed the connection")?;
                    return Err(RuntimeError::PeerClosed);
                }
            };
            match self.handle(message)? {
                Some(exit) => {
                    // Do not join the reader thread: after dispose it may
                    // still be blocked on stdin until the peer closes its
                    // pipe. The process exits promptly after `Quiescent`;
                    // the reader thread dies with it.
                    return Ok(exit);
                }
                None => continue,
            }
        }
    }

    fn handle(&mut self, message: BridgeMessage) -> Result<Option<SideExit>, RuntimeError> {
        match message {
            BridgeMessage::Hello(peer) => {
                if self.handshake_done {
                    return Err(RuntimeError::PreHandshake);
                }
                let expected_digest = manifest_source_digest();
                let required: Vec<&str> = self
                    .config
                    .required_peer_capabilities
                    .iter()
                    .map(String::as_str)
                    .collect();
                self.config
                    .hello
                    .validate_peer(&peer, &expected_digest, &required)?;
                self.handshake_done = true;
                Ok(None)
            }
            _other if !self.handshake_done => Err(RuntimeError::PreHandshake),
            BridgeMessage::Call {
                generation,
                id,
                service,
                method,
                args,
            } => {
                self.check_generation(generation)?;
                self.dispatch_call(id, service, method, args)?;
                Ok(None)
            }
            BridgeMessage::Cancel { generation, id } => {
                self.check_generation(generation)?;
                if let Some(flag) = self
                    .pending
                    .lock()
                    .expect("pending lock must not poison")
                    .get(&id)
                {
                    flag.store(true, Ordering::SeqCst);
                }
                if let Some(owner) = self.find_owner(&id) {
                    owner.on_cancel(&id);
                }
                Ok(None)
            }
            BridgeMessage::Dispose { generation } => {
                self.check_generation(generation)?;
                // Stop new work, then release every service-owned resource
                // (processes, handles) before joining in-flight calls.
                for service in self.config.services.all() {
                    service.shutdown();
                }
                self.lifecycle
                    .lock()
                    .expect("lifecycle lock must not poison")
                    .dispose();
                for worker in self.workers.drain(..) {
                    let _ = worker.join();
                }
                let quiescent = self
                    .lifecycle
                    .lock()
                    .expect("lifecycle lock must not poison")
                    .is_quiescent();
                if !quiescent {
                    // In-flight work finished, but something leaked (should
                    // not happen for first-party services); still report.
                    self.reject_pending("dispose left owned state behind")?;
                }
                self.write(&BridgeMessage::Quiescent { generation })?;
                Ok(Some(SideExit::Quiescent))
            }
            BridgeMessage::ResourceOpen { generation, id, .. } => {
                self.check_generation(generation)?;
                self.reply_error(id, crate::service::unsupported("resource/open"))?;
                Ok(None)
            }
            BridgeMessage::StreamOpen {
                generation,
                id,
                resource_type,
                credit_bytes,
            } => {
                self.check_generation(generation)?;
                self.open_stream(id, resource_type, credit_bytes)?;
                Ok(None)
            }
            BridgeMessage::StreamCredit {
                generation,
                id,
                credit_bytes,
            } => {
                self.check_generation(generation)?;
                if let Some(owner) = self.find_owner(&id) {
                    if let Err(error) = owner.stream_credit(&id, credit_bytes) {
                        self.reply_error(id, error)?;
                    }
                } else {
                    self.reply_error(id, crate::service::unsupported("stream/credit"))?;
                }
                Ok(None)
            }
            BridgeMessage::ResourceRelease { generation, id } => {
                self.check_generation(generation)?;
                if let Some(owner) = self.find_owner(&id) {
                    match owner.release_resource(&id) {
                        Ok(()) => self.write(&BridgeMessage::Reply {
                            generation,
                            id,
                            result: serde_json::json!({ "released": true }),
                        })?,
                        Err(error) => self.reply_error(id, error)?,
                    }
                } else {
                    self.reply_error(id, crate::service::unsupported("resource/release"))?;
                }
                Ok(None)
            }
            BridgeMessage::ContributionRegister {
                generation,
                id,
                plugin,
                service,
            } => {
                self.check_generation(generation)?;
                // First-party sidecar: contributions are accepted as
                // registrations but there is no dynamic dispatch surface yet;
                // ack so the peer can proceed and exercise continuation
                // semantics against the test service.
                self.write(&BridgeMessage::Reply {
                    generation,
                    id,
                    result: serde_json::json!({
                        "plugin": plugin,
                        "service": service,
                        "registered": true,
                    }),
                })?;
                Ok(None)
            }
            BridgeMessage::ContributionRemove { generation, id, .. } => {
                self.check_generation(generation)?;
                self.write(&BridgeMessage::Reply {
                    generation,
                    id,
                    result: serde_json::json!({ "removed": true }),
                })?;
                Ok(None)
            }
            BridgeMessage::ContinuationCall {
                generation,
                id,
                payload,
            } => {
                self.check_generation(generation)?;
                self.route_continuation(id, ContinuationMessage::Call { payload })
            }
            BridgeMessage::ContinuationReply {
                generation,
                id,
                payload,
                error,
            } => {
                self.check_generation(generation)?;
                self.route_continuation(id, ContinuationMessage::Reply { payload, error })
            }
            // Event frames target guest listeners; nothing registers a
            // listener on the first-party sidecar, so they are acknowledged
            // as unknown rather than silently dropped.
            BridgeMessage::EventInvoke {
                generation,
                id,
                event,
                ..
            } => {
                self.check_generation(generation)?;
                self.reply_error(
                    id,
                    ServiceError::new(
                        "bridge.no_listener",
                        format!("no listener registered for event {event:?}"),
                    ),
                )?;
                Ok(None)
            }
            // One-way kinds without local meaning in this phase are ignored;
            // they carry their own terminal semantics for the sender.
            _ => Ok(None),
        }
    }

    fn open_stream(
        &mut self,
        id: BridgeId,
        resource_type: String,
        credit_bytes: u32,
    ) -> Result<(), RuntimeError> {
        let Some(owner) = self.find_owner(&id) else {
            return self.reply_error(id, crate::service::unsupported("stream/open"));
        };
        let ctx = CallContext {
            generation: self.generation,
            id: id.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let sink = self.sink();
        match owner.open_stream(&id, &resource_type, credit_bytes, &ctx, sink) {
            Ok(()) => self.write(&BridgeMessage::Reply {
                generation: self.generation,
                id,
                result: serde_json::json!({ "opened": true }),
            }),
            Err(error) => self.reply_error(id, error),
        }
    }

    fn check_generation(&self, generation: u64) -> Result<(), RuntimeError> {
        if generation != self.generation {
            return Err(RuntimeError::Unsupported {
                kind: "generation mismatch",
            });
        }
        Ok(())
    }

    /// Routes a continuation frame to its waiting receiver; unknown ids are
    /// rejected with a typed error.
    ///
    /// A waterfall continuation stays pending across the peer's `next()`
    /// (`continuation/call`) so the listener can still terminate with its
    /// own `continuation/reply`; the terminal reply removes the id. A late
    /// frame on a completed continuation is rejected as stale.
    fn route_continuation(
        &mut self,
        id: BridgeId,
        message: ContinuationMessage,
    ) -> Result<Option<SideExit>, RuntimeError> {
        let terminal = matches!(message, ContinuationMessage::Reply { .. });
        let sender = {
            let mut continuations = self
                .continuations
                .lock()
                .expect("continuations lock must not poison");
            if let Some(sender) = continuations.get(&id) {
                let sender = sender.clone();
                if terminal {
                    continuations.remove(&id);
                }
                Some(sender)
            } else {
                None
            }
        };
        match sender {
            Some(sender) => {
                let _ = sender.send(message);
                Ok(None)
            }
            None => {
                self.reply_error(
                    id,
                    ServiceError::new(
                        "bridge.stale_continuation",
                        "continuation is not pending (late or consumed)",
                    ),
                )?;
                Ok(None)
            }
        }
    }

    fn find_owner(&self, id: &BridgeId) -> Option<Arc<dyn Service>> {
        self.config
            .services
            .all()
            .into_iter()
            .find(|service| service.owns(id))
    }

    fn dispatch_call(
        &mut self,
        id: BridgeId,
        service_name: String,
        method: String,
        args: serde_json::Value,
    ) -> Result<(), RuntimeError> {
        let accepted = {
            let mut lifecycle = self
                .lifecycle
                .lock()
                .expect("lifecycle lock must not poison");
            match lifecycle.begin_work() {
                Ok(()) => true,
                Err(error) => {
                    drop(lifecycle);
                    self.reply_error(id.clone(), lifecycle_to_service_error(error))?;
                    false
                }
            }
        };
        if !accepted {
            return Ok(());
        }
        let Some(service) = self.config.services.resolve(&service_name) else {
            self.lifecycle
                .lock()
                .expect("lifecycle lock must not poison")
                .end_work()
                .expect("begin_work succeeded, so end_work must too");
            return self.reply_error(
                id,
                ServiceError::new(
                    "bridge.no_service",
                    format!("unknown service {service_name:?}"),
                ),
            );
        };

        let cancel = Arc::new(AtomicBool::new(false));
        self.pending
            .lock()
            .expect("pending lock must not poison")
            .insert(id.clone(), cancel.clone());

        let writer = Arc::clone(&self.writer);
        let lifecycle = Arc::clone(&self.lifecycle);
        let pending = Arc::clone(&self.pending);
        let generation = self.generation;
        let reply_id = id.clone();
        let sink = self.sink();

        self.workers.push(std::thread::spawn(move || {
            let context = CallContext {
                generation,
                id: reply_id.clone(),
                cancel: Arc::clone(&cancel),
            };
            let result = service.call(&method, &args, &context, sink);
            let message = match result {
                Ok(value) => BridgeMessage::Reply {
                    generation,
                    id: reply_id.clone(),
                    result: value,
                },
                Err(error) => BridgeMessage::Error {
                    generation,
                    id: reply_id.clone(),
                    error: RemoteError::from(error),
                },
            };
            pending
                .lock()
                .expect("pending lock must not poison")
                .remove(&reply_id);
            lifecycle
                .lock()
                .expect("lifecycle lock must not poison")
                .end_work()
                .expect("worker owns the in-flight slot it releases");
            let mut writer = writer.lock().expect("writer lock must not poison");
            let _ = dsh_bridge_protocol::write_frame(&mut *writer, &message);
        }));
        Ok(())
    }

    fn reply_error(&mut self, id: BridgeId, error: ServiceError) -> Result<(), RuntimeError> {
        self.write(&BridgeMessage::Error {
            generation: self.generation,
            id,
            error: RemoteError::from(error),
        })
    }

    fn reject_pending(&self, message: &str) -> Result<(), RuntimeError> {
        // Completes every in-flight request with a typed error; the terminal
        // frame the service still owes is discarded by the client as stale.
        let ids: Vec<BridgeId> = self
            .pending
            .lock()
            .expect("pending lock must not poison")
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.write(&BridgeMessage::Error {
                generation: self.generation,
                id,
                error: RemoteError {
                    code: "bridge.peer_closed".to_owned(),
                    message: message.to_owned(),
                    retryable: false,
                    cancelled: false,
                    data: None,
                },
            })?;
        }
        Ok(())
    }
}

fn lifecycle_to_service_error(error: dsh_bridge_protocol::LifecycleError) -> ServiceError {
    match error {
        dsh_bridge_protocol::LifecycleError::Quiescing => {
            ServiceError::new("bridge.quiescing", "connection is shutting down")
        }
        other => ServiceError::new("bridge.rejected", other.to_string()),
    }
}

fn spawn_reader<R>(
    reader: R,
    tx: Sender<Result<BridgeMessage, RuntimeError>>,
    max_frame_size: usize,
) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut decoder = FrameDecoder::new(max_frame_size);
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let messages = match decoder.push(&buffer[..read]) {
                        Ok(messages) => messages,
                        Err(error) => {
                            let _ = tx.send(Err(RuntimeError::Frame(error)));
                            return;
                        }
                    };
                    for message in messages {
                        if tx.send(Ok(message)).is_err() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(RuntimeError::Io(error)));
                    return;
                }
            }
        }
    })
}
