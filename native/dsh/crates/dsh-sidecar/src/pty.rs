//! PTY capability service for the migration bridge.
//!
//! P1 execution-world prototype: PTY allocation, ordered input/output,
//! resize, signals, foreground-process handling, cancellation and full
//! session quiescence. Uses `portable-pty` for cross-platform PTY
//! semantics (macOS / Linux / Windows).
//!
//! The child runs attached to the PTY slave; the master reader is pumped as
//! a credit-bounded bridge stream (id `<pty>.output`) once the caller opens
//! it, input is written through `pty.write` (base64), `pty.signal` forwards
//! a signal to the child, and `resource/release`, `cancel` and `shutdown`
//! kill the child and close the PTY so no handle or process outlives the
//! connection.

use dsh_bridge_protocol::{BridgeId, BridgeMessage, RemoteError};
use dsh_bridge_runtime::{CallContext, FrameSink, Service, ServiceError};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

/// Stable error codes exposed by the PTY service.
pub mod codes {
    /// PTY allocation failed.
    pub const ALLOC: &str = "pty.alloc";
    /// Spawning the attached command failed.
    pub const SPAWN: &str = "pty.spawn";
    /// A pty id is not registered.
    pub const UNKNOWN: &str = "pty.unknown";
    /// Bad arguments.
    pub const BAD_ARGS: &str = "pty.bad_args";
    /// The PTY master writer is gone.
    pub const CLOSED: &str = "pty.closed";
}

/// Default terminal size.
const DEFAULT_SIZE: PtySize = PtySize {
    rows: 24,
    cols: 80,
    pixel_width: 0,
    pixel_height: 0,
};

struct PtyState {
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    reader: Mutex<Option<Box<dyn Read + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    cancel: AtomicBool,
}

impl PtyState {
    fn reader_take(&self) -> Option<Box<dyn Read + Send>> {
        self.reader
            .lock()
            .expect("reader lock must not poison")
            .take()
    }
}

/// Receiver credit ledger for the PTY output stream.
struct StreamCredit {
    available: Mutex<u64>,
    signal: Condvar,
}

impl StreamCredit {
    fn new() -> Self {
        Self {
            available: Mutex::new(0),
            signal: Condvar::new(),
        }
    }

    fn wait_at_least(&self, bytes: u64, cancelled: &AtomicBool) -> Option<u64> {
        let mut available = self.available.lock().expect("credit lock must not poison");
        loop {
            if *available >= bytes {
                return Some(*available);
            }
            if cancelled.load(Ordering::SeqCst) {
                return None;
            }
            let (guard, _) = self
                .signal
                .wait_timeout(available, std::time::Duration::from_millis(50))
                .expect("credit condvar must not poison");
            available = guard;
        }
    }

    fn consume(&self, bytes: u64) {
        let mut available = self.available.lock().expect("credit lock must not poison");
        *available = available.saturating_sub(bytes);
    }

    fn grant(&self, bytes: u32) {
        let mut available = self.available.lock().expect("credit lock must not poison");
        *available = available.saturating_add(bytes as u64);
        self.signal.notify_all();
    }
}

struct PtyRecord {
    state: Arc<PtyState>,
    credit: Arc<StreamCredit>,
    sequence: AtomicU64,
    generation: AtomicU64,
    output_id: BridgeId,
}

/// The `pty` bridge service (P1 prototype scope).
#[derive(Default)]
pub struct PtyService {
    ptys: Mutex<HashMap<BridgeId, Arc<PtyRecord>>>,
    pumps: Mutex<Vec<JoinHandle<()>>>,
    next_id: AtomicU64,
}

impl PtyService {
    /// Creates the service.
    pub fn new() -> Self {
        Self::default()
    }

    /// `open { command, args?, cwd?, cols?, rows? }` -> `{ ptyId, output }`
    ///
    /// Allocates a PTY, spawns `command` on the slave, and returns the pty id
    /// plus the output stream id. The caller opens the output stream with
    /// `stream/open` and feeds input with `pty.write`.
    fn open(&self, args: &Value) -> Result<Value, ServiceError> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceError::new(codes::BAD_ARGS, "missing string arg `command`"))?
            .to_owned();
        let argv: Vec<String> = args
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let size = PtySize {
            cols: args
                .get("cols")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(DEFAULT_SIZE.cols),
            rows: args
                .get("rows")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(DEFAULT_SIZE.rows),
            ..DEFAULT_SIZE
        };

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| ServiceError::new(codes::ALLOC, error.to_string()))?;
        let mut builder = CommandBuilder::new(&command);
        builder.args(&argv);
        if let Some(cwd) = args.get("cwd").and_then(Value::as_str) {
            builder.cwd(cwd);
        }
        let child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| ServiceError::new(codes::SPAWN, error.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| ServiceError::new(codes::ALLOC, error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| ServiceError::new(codes::ALLOC, error.to_string()))?;
        // Keep the master handle itself for `resize` (it borrows &self); the
        // reader and writer above are independent fd clones.
        let master = pair.master;

        let n = self.next_id.fetch_add(1, Ordering::SeqCst);
        let pty_id = BridgeId::new(format!("pty-{n}")).expect("generated id must be valid");
        let output_id = BridgeId::new(format!("{}.output", pty_id.as_str()))
            .expect("generated stream id must be valid");
        let state = Arc::new(PtyState {
            child: Mutex::new(Some(child)),
            master: Mutex::new(Some(master)),
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
            cancel: AtomicBool::new(false),
        });
        let record = Arc::new(PtyRecord {
            state: Arc::clone(&state),
            credit: Arc::new(StreamCredit::new()),
            sequence: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            output_id: output_id.clone(),
        });
        self.ptys
            .lock()
            .expect("ptys lock must not poison")
            .insert(pty_id.clone(), Arc::clone(&record));

        // The pump thread owns the reader and starts once the output stream
        // is opened (credit grant + generation recorded below).
        Ok(json!({
            "ptyId": pty_id.as_str(),
            "output": output_id.as_str(),
        }))
    }

    /// `write { ptyId, data }` -> `{ bytes }`
    ///
    /// Writes base64 `data` to the PTY master (the child's stdin). Order is
    /// preserved by the master writer.
    fn write(&self, args: &Value) -> Result<Value, ServiceError> {
        let pty_id = self.id_arg(args)?;
        let data = args
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceError::new(codes::BAD_ARGS, "missing base64 arg `data`"))?;
        use base64::engine::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| {
                ServiceError::new(codes::BAD_ARGS, format!("invalid base64: {error}"))
            })?;
        let record = self
            .find(&pty_id)
            .ok_or_else(|| ServiceError::new(codes::UNKNOWN, format!("unknown pty {pty_id:?}")))?;
        let mut writer = record
            .state
            .writer
            .lock()
            .expect("writer lock must not poison");
        let writer = writer
            .as_mut()
            .ok_or_else(|| ServiceError::new(codes::CLOSED, "pty master writer is gone"))?;
        writer
            .write_all(&bytes)
            .map_err(|error| ServiceError::new(codes::CLOSED, error.to_string()))?;
        writer
            .flush()
            .map_err(|error| ServiceError::new(codes::CLOSED, error.to_string()))?;
        Ok(json!({ "bytes": bytes.len() }))
    }

    /// `resize { ptyId, cols, rows }` -> `{ cols, rows }`
    fn resize(&self, args: &Value) -> Result<Value, ServiceError> {
        let pty_id = self.id_arg(args)?;
        let cols = args
            .get("cols")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .ok_or_else(|| ServiceError::new(codes::BAD_ARGS, "missing u16 arg `cols`"))?;
        let rows = args
            .get("rows")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .ok_or_else(|| ServiceError::new(codes::BAD_ARGS, "missing u16 arg `rows`"))?;
        let record = self
            .find(&pty_id)
            .ok_or_else(|| ServiceError::new(codes::UNKNOWN, format!("unknown pty {pty_id:?}")))?;
        let mut master = record
            .state
            .master
            .lock()
            .expect("master lock must not poison");
        let master = master
            .as_mut()
            .ok_or_else(|| ServiceError::new(codes::CLOSED, "pty master is gone"))?;
        master
            .resize(PtySize {
                cols,
                rows,
                ..DEFAULT_SIZE
            })
            .map_err(|error| ServiceError::new(codes::ALLOC, error.to_string()))?;
        Ok(json!({ "cols": cols, "rows": rows }))
    }

    /// `signal { ptyId, signal }` -> `{ signal }`
    ///
    /// Forwards a signal name (e.g. `SIGTERM`, `SIGWINCH`, `SIGINT`) to the
    /// child process.
    fn signal(&self, args: &Value) -> Result<Value, ServiceError> {
        let pty_id = self.id_arg(args)?;
        let name = args
            .get("signal")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceError::new(codes::BAD_ARGS, "missing string arg `signal`"))?;
        let record = self
            .find(&pty_id)
            .ok_or_else(|| ServiceError::new(codes::UNKNOWN, format!("unknown pty {pty_id:?}")))?;
        let signal = signal_from_name(name).ok_or_else(|| {
            ServiceError::new(codes::BAD_ARGS, format!("unknown signal {name:?}"))
        })?;
        #[cfg(unix)]
        {
            let child = record
                .state
                .child
                .lock()
                .expect("child lock must not poison");
            let child = child
                .as_ref()
                .ok_or_else(|| ServiceError::new(codes::CLOSED, "pty child is gone"))?;
            unsafe {
                libc::kill(child.process_id().unwrap_or(0) as i32, signal);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            return Err(ServiceError::new(
                codes::CLOSED,
                "signal forwarding is unix-only in this phase",
            ));
        }
        Ok(json!({ "signal": name }))
    }

    fn id_arg(&self, args: &Value) -> Result<BridgeId, ServiceError> {
        let value = args
            .get("ptyId")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceError::new(codes::BAD_ARGS, "missing string arg `ptyId`"))?;
        BridgeId::new(value).map_err(|error| ServiceError::new(codes::BAD_ARGS, error))
    }

    fn find(&self, id: &BridgeId) -> Option<Arc<PtyRecord>> {
        self.ptys
            .lock()
            .expect("ptys lock must not poison")
            .get(id)
            .cloned()
    }

    fn find_by_output(&self, id: &BridgeId) -> Option<Arc<PtyRecord>> {
        self.ptys
            .lock()
            .expect("ptys lock must not poison")
            .values()
            .find(|record| &record.output_id == id)
            .cloned()
    }

    fn kill_all(&self) {
        for record in self
            .ptys
            .lock()
            .expect("ptys lock must not poison")
            .values()
        {
            record.state.cancel.store(true, Ordering::SeqCst);
            if let Some(mut child) = record
                .state
                .child
                .lock()
                .expect("child lock must not poison")
                .take()
            {
                let _ = child.kill();
            }
        }
    }
}

fn signal_from_name(name: &str) -> Option<i32> {
    #[cfg(unix)]
    {
        Some(match name {
            "SIGHUP" => libc::SIGHUP,
            "SIGINT" => libc::SIGINT,
            "SIGQUIT" => libc::SIGQUIT,
            "SIGTERM" => libc::SIGTERM,
            "SIGKILL" => libc::SIGKILL,
            "SIGWINCH" => libc::SIGWINCH,
            "SIGCONT" => libc::SIGCONT,
            "SIGSTOP" => libc::SIGSTOP,
            _ => return None,
        })
    }
    #[cfg(not(unix))]
    {
        let _ = name;
        None
    }
}

impl Service for PtyService {
    fn service_name(&self) -> &str {
        "pty"
    }

    fn call(
        &self,
        method: &str,
        args: &Value,
        _ctx: &CallContext,
        _sink: Arc<dyn FrameSink>,
    ) -> Result<Value, ServiceError> {
        match method {
            "open" => self.open(args),
            "write" => self.write(args),
            "resize" => self.resize(args),
            "signal" => self.signal(args),
            other => Err(ServiceError::new(
                "bridge.no_method",
                format!("pty.{other} is not served in this migration phase"),
            )),
        }
    }

    fn owns(&self, id: &BridgeId) -> bool {
        self.ptys
            .lock()
            .expect("ptys lock must not poison")
            .contains_key(id)
            || self.find_by_output(id).is_some()
    }

    fn open_stream(
        &self,
        id: &BridgeId,
        _resource_type: &str,
        credit_bytes: u32,
        ctx: &CallContext,
        sink: Arc<dyn FrameSink>,
    ) -> Result<(), ServiceError> {
        let record = self
            .find_by_output(id)
            .ok_or_else(|| ServiceError::new(codes::UNKNOWN, format!("unknown stream {id:?}")))?;
        record.credit.grant(credit_bytes);
        record.generation.store(ctx.generation, Ordering::SeqCst);

        // Start the pump only now: it needs the connection sink and the
        // reader; `open` stashed the reader in the state under `reader_ready`.
        let reader = record.state.reader_take().ok_or_else(|| {
            ServiceError::new(codes::UNKNOWN, format!("stream {id:?} already consumed"))
        })?;
        let record_for_pump = Arc::clone(&record);
        self.pumps
            .lock()
            .expect("pumps lock must not poison")
            .push(std::thread::spawn(move || {
                pump(record_for_pump, reader, sink);
            }));
        Ok(())
    }

    fn stream_credit(&self, id: &BridgeId, credit_bytes: u32) -> Result<(), ServiceError> {
        let record = self
            .find_by_output(id)
            .ok_or_else(|| ServiceError::new(codes::UNKNOWN, format!("unknown stream {id:?}")))?;
        record.credit.grant(credit_bytes);
        Ok(())
    }

    fn release_resource(&self, id: &BridgeId) -> Result<(), ServiceError> {
        if let Some(record) = self
            .ptys
            .lock()
            .expect("ptys lock must not poison")
            .remove(id)
        {
            record.state.cancel.store(true, Ordering::SeqCst);
            if let Some(mut child) = record
                .state
                .child
                .lock()
                .expect("child lock must not poison")
                .take()
            {
                let _ = child.kill();
            }
        }
        Ok(())
    }

    fn on_cancel(&self, id: &BridgeId) {
        let record = self.find(id).or_else(|| self.find_by_output(id));
        if let Some(record) = record {
            record.state.cancel.store(true, Ordering::SeqCst);
            if let Some(mut child) = record
                .state
                .child
                .lock()
                .expect("child lock must not poison")
                .take()
            {
                let _ = child.kill();
            }
        }
    }

    fn shutdown(&self) {
        self.kill_all();
        for pump in self
            .pumps
            .lock()
            .expect("pumps lock must not poison")
            .drain(..)
        {
            let _ = pump.join();
        }
    }
}

fn pump(record: Arc<PtyRecord>, mut reader: Box<dyn Read + Send>, sink: Arc<dyn FrameSink>) {
    let generation = record.generation.load(Ordering::SeqCst);
    let id = record.output_id.clone();
    let mut buffer = [0u8; 8192];
    let mut error = None;
    loop {
        if record.state.cancel.load(Ordering::SeqCst) {
            error = Some(RemoteError {
                code: "cancelled".to_owned(),
                message: "pty session terminated".to_owned(),
                retryable: false,
                cancelled: true,
                data: None,
            });
            break;
        }
        let Some(available) = record.credit.wait_at_least(1, &record.state.cancel) else {
            error = Some(RemoteError {
                code: "cancelled".to_owned(),
                message: "pty session terminated".to_owned(),
                retryable: false,
                cancelled: true,
                data: None,
            });
            break;
        };
        let mut limited = reader.by_ref().take(available);
        let read = match limited.read(&mut buffer) {
            Ok(0) => {
                if record.state.cancel.load(Ordering::SeqCst) {
                    error = Some(RemoteError {
                        code: "cancelled".to_owned(),
                        message: "pty session terminated".to_owned(),
                        retryable: false,
                        cancelled: true,
                        data: None,
                    });
                }
                break;
            }
            Ok(read) => read,
            Err(_) => {
                error = Some(RemoteError {
                    code: "pty.pipe".to_owned(),
                    message: "pty master closed unexpectedly".to_owned(),
                    retryable: false,
                    cancelled: false,
                    data: None,
                });
                break;
            }
        };
        let sequence = record.sequence.fetch_add(1, Ordering::SeqCst);
        if sink
            .send(BridgeMessage::StreamChunk {
                generation,
                id: id.clone(),
                sequence,
                data: buffer[..read].to_vec(),
            })
            .is_err()
        {
            return;
        }
        record.credit.consume(read as u64);
    }
    let _ = sink.send(BridgeMessage::StreamEnd {
        generation,
        id,
        error,
    });
}
