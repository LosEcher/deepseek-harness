//! Subprocess capability service for the migration bridge.
//!
//! P1 execution-world prototype: collect mode with spill reporting, piped
//! output streams with receiver credit, process-tree termination, and
//! cancellation. On Unix the child is spawned as its own process-group
//! leader so killing the group terminates the whole tree.

use dsh_bridge_protocol::{BridgeId, BridgeMessage, RemoteError};
use dsh_bridge_runtime::{CallContext, FrameSink, Service, ServiceError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

/// Stable error codes exposed by the subprocess service.
pub mod codes {
    /// Command failed to start.
    pub const SPAWN: &str = "subprocess.spawn";
    /// A stream or process id is not registered.
    pub const UNKNOWN: &str = "subprocess.unknown";
    /// Bad arguments.
    pub const BAD_ARGS: &str = "subprocess.bad_args";
}

/// Default in-memory output cap for collect mode before spilling.
const DEFAULT_MAX_BYTES: u64 = 1024 * 1024;

struct ProcessState {
    id: BridgeId,
    child: Mutex<Option<Child>>,
    stdout: Mutex<Option<ChildStdout>>,
    stderr: Mutex<Option<ChildStderr>>,
    cancel: AtomicBool,
}

impl ProcessState {
    fn spawn(command: String, argv: Vec<String>, cwd: Option<String>) -> std::io::Result<Self> {
        let mut cmd = Command::new(&command);
        cmd.args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group so a kill hits the whole tree.
            cmd.process_group(0);
        }
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        Ok(Self {
            id: BridgeId::new(format!("proc-{}", std::process::id()))
                .expect("process id must be valid"),
            child: Mutex::new(Some(child)),
            stdout: Mutex::new(stdout),
            stderr: Mutex::new(stderr),
            cancel: AtomicBool::new(false),
        })
    }

    fn kill_tree(&self) {
        let child = self.child.lock().expect("child lock must not poison");
        if let Some(child) = child.as_ref() {
            kill_process_group(child.id());
        }
    }
}

/// Receiver credit ledger for one output stream.
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

    /// Waits until at least `bytes` of credit are available.
    ///
    /// Returns the current available amount, or `None` once `cancelled` is
    /// set (checked on a short timeout so a cancelled pump never blocks).
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

enum StreamKind {
    Stdout,
    Stderr,
}

struct StreamRecord {
    process: Arc<ProcessState>,
    kind: StreamKind,
    credit: Arc<StreamCredit>,
    sequence: AtomicU64,
    generation: AtomicU64,
    id: BridgeId,
}

/// The `subprocess` bridge service (P1 prototype scope).
#[derive(Default)]
pub struct SubprocessService {
    processes: Mutex<HashMap<BridgeId, Arc<ProcessState>>>,
    streams: Mutex<HashMap<BridgeId, Arc<StreamRecord>>>,
    pumps: Mutex<Vec<JoinHandle<()>>>,
    next_id: AtomicU64,
}

impl SubprocessService {
    /// Creates the service.
    pub fn new() -> Self {
        Self::default()
    }

    fn next_process_id(&self) -> BridgeId {
        let n = self.next_id.fetch_add(1, Ordering::SeqCst);
        BridgeId::new(format!("proc-{n}")).expect("generated id must be valid")
    }

    /// `runCollect { command, args?, cwd?, maxBytes? }` -> collect result
    ///
    /// Runs the command to completion, capturing stdout/stderr with an
    /// in-memory cap. Output beyond the cap spills to a temporary file and is
    /// reported via `spilled` / `spillPath`. The call is cancellable; cancel
    /// kills the whole process group.
    fn run_collect(&self, args: &Value, ctx: &CallContext) -> Result<Value, ServiceError> {
        let (command, argv, cwd) = parse_command(args)?;
        let max_bytes = args
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_MAX_BYTES);
        let mut cmd = Command::new(&command);
        cmd.args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|error| {
            ServiceError::new(
                codes::SPAWN,
                format!("{command:?} failed to start: {error}"),
            )
        })?;
        let stdout = child.stdout.take().expect("stdout pipe must exist");
        let stderr = child.stderr.take().expect("stderr pipe must exist");

        let out_state = Arc::new(Mutex::new(CollectState::new(max_bytes)));
        let err_state = Arc::new(Mutex::new(CollectState::new(max_bytes)));
        let out_thread = drain_pipe(stdout, Arc::clone(&out_state));
        let err_thread = drain_pipe(stderr, Arc::clone(&err_state));

        let status = loop {
            if ctx.is_cancelled() {
                kill_process_group(child.id());
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(ServiceError::cancelled());
            }
            if let Some(status) = child.try_wait().map_err(|error| {
                ServiceError::new(codes::SPAWN, format!("{command:?} wait failed: {error}"))
            })? {
                break status;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        let _ = out_thread.join();
        let _ = err_thread.join();

        let stdout = {
            let mut state = out_state.lock().expect("state lock must not poison");
            std::mem::replace(&mut *state, CollectState::new(max_bytes)).finish()
        };
        let stderr = {
            let mut state = err_state.lock().expect("state lock must not poison");
            std::mem::replace(&mut *state, CollectState::new(max_bytes)).finish()
        };
        let mut result = json!({
            "exit_code": status.code(),
            "stdout": stdout.text,
            "stderr": stderr.text,
            "spilled": stdout.spilled || stderr.spilled,
        });
        if let Some(path) = stdout.spill_path.or(stderr.spill_path) {
            result["spill_path"] = json!(path);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = status.signal() {
                result["signal"] = json!(signal);
            }
        }
        Ok(result)
    }

    /// `spawn { command, args?, cwd? }` -> `{ processId, stdout, stderr }`
    ///
    /// Starts the command with piped output and returns two stream ids. The
    /// caller then opens each stream with `stream/open` and receives chunks
    /// under receiver credit.
    fn spawn_piped(&self, args: &Value) -> Result<Value, ServiceError> {
        let (command, argv, cwd) = parse_command(args)?;
        let process_id = self.next_process_id();
        let mut spawned = ProcessState::spawn(command.clone(), argv, cwd).map_err(|error| {
            ServiceError::new(
                codes::SPAWN,
                format!("{command:?} failed to start: {error}"),
            )
        })?;
        spawned.id = process_id.clone();
        let process = Arc::new(spawned);

        let stdout_id = BridgeId::new(format!("{}.stdout", process_id.as_str()))
            .expect("generated stream id must be valid");
        let stderr_id = BridgeId::new(format!("{}.stderr", process_id.as_str()))
            .expect("generated stream id must be valid");

        self.streams
            .lock()
            .expect("streams lock must not poison")
            .insert(
                stdout_id.clone(),
                Arc::new(StreamRecord {
                    process: Arc::clone(&process),
                    kind: StreamKind::Stdout,
                    credit: Arc::new(StreamCredit::new()),
                    sequence: AtomicU64::new(0),
                    generation: AtomicU64::new(0),
                    id: stdout_id.clone(),
                }),
            );
        self.streams
            .lock()
            .expect("streams lock must not poison")
            .insert(
                stderr_id.clone(),
                Arc::new(StreamRecord {
                    process: Arc::clone(&process),
                    kind: StreamKind::Stderr,
                    credit: Arc::new(StreamCredit::new()),
                    sequence: AtomicU64::new(0),
                    generation: AtomicU64::new(0),
                    id: stderr_id.clone(),
                }),
            );
        self.processes
            .lock()
            .expect("processes lock must not poison")
            .insert(process_id.clone(), process);

        Ok(json!({
            "processId": process_id.as_str(),
            "stdout": stdout_id.as_str(),
            "stderr": stderr_id.as_str(),
        }))
    }

    fn find_stream(&self, id: &BridgeId) -> Option<Arc<StreamRecord>> {
        self.streams
            .lock()
            .expect("streams lock must not poison")
            .get(id)
            .cloned()
    }

    fn pump(
        &self,
        record: Arc<StreamRecord>,
        reader: Box<dyn Read + Send>,
        sink: Arc<dyn FrameSink>,
    ) {
        self.pumps
            .lock()
            .expect("pumps lock must not poison")
            .push(std::thread::spawn(move || {
                let generation = record.generation.load(Ordering::SeqCst);
                let id = record.id.clone();
                let mut reader = reader;
                let mut buffer = [0u8; 8192];
                let mut error = None;
                loop {
                    if record.process.cancel.load(Ordering::SeqCst) {
                        error = Some(RemoteError {
                            code: "cancelled".to_owned(),
                            message: "process tree terminated".to_owned(),
                            retryable: false,
                            cancelled: true,
                            data: None,
                        });
                        break;
                    }
                    // Wait for at least one byte of receiver credit, then read
                    // no more than the currently available amount so the
                    // chunk never violates the credit ledger.
                    let Some(available) = record.credit.wait_at_least(1, &record.process.cancel)
                    else {
                        error = Some(RemoteError {
                            code: "cancelled".to_owned(),
                            message: "process tree terminated".to_owned(),
                            retryable: false,
                            cancelled: true,
                            data: None,
                        });
                        break;
                    };
                    let mut limited = reader.by_ref().take(available);
                    let read = match limited.read(&mut buffer) {
                        Ok(0) => {
                            // EOF: clean unless the process was cancelled.
                            if record.process.cancel.load(Ordering::SeqCst) {
                                error = Some(RemoteError {
                                    code: "cancelled".to_owned(),
                                    message: "process tree terminated".to_owned(),
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
                                code: "subprocess.pipe".to_owned(),
                                message: "output pipe closed unexpectedly".to_owned(),
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
            }));
    }

    fn kill_all(&self) {
        for process in self
            .processes
            .lock()
            .expect("processes lock must not poison")
            .values()
        {
            process.cancel.store(true, Ordering::SeqCst);
            process.kill_tree();
        }
    }
}

/// Kill a whole unix process group; falls back to killing the pid.
fn kill_process_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        let group = -(pid as i32);
        libc::kill(group, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

struct CollectState {
    max_bytes: u64,
    text: Vec<u8>,
    spilled: bool,
    spill_path: Option<String>,
    spill_file: Option<std::fs::File>,
}

impl CollectState {
    fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes,
            text: Vec::new(),
            spilled: false,
            spill_path: None,
            spill_file: None,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.spilled {
            if let Some(file) = self.spill_file.as_mut() {
                use std::io::Write;
                let _ = file.write_all(bytes);
            }
            return;
        }
        let room = self.max_bytes.saturating_sub(self.text.len() as u64) as usize;
        if bytes.len() <= room {
            self.text.extend_from_slice(bytes);
            return;
        }
        self.text.extend_from_slice(&bytes[..room]);
        self.spilled = true;
        let path = std::env::temp_dir().join(format!(
            "dsh-collect-{}-{}.spill",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        use std::io::Write;
        let mut file = std::fs::File::create(&path).expect("spill file must be creatable");
        let _ = file.write_all(&bytes[room..]);
        self.spill_path = Some(path.to_string_lossy().into_owned());
        self.spill_file = Some(file);
    }

    fn finish(self) -> CollectResult {
        CollectResult {
            text: String::from_utf8_lossy(&self.text).into_owned(),
            spilled: self.spilled,
            spill_path: self.spill_path,
        }
    }
}

struct CollectResult {
    text: String,
    spilled: bool,
    spill_path: Option<String>,
}

fn drain_pipe(
    mut reader: impl Read + Send + 'static,
    state: Arc<Mutex<CollectState>>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => state
                    .lock()
                    .expect("state lock must not poison")
                    .push(&buffer[..read]),
                Err(_) => break,
            }
        }
    })
}

fn parse_command(args: &Value) -> Result<(String, Vec<String>, Option<String>), ServiceError> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| ServiceError::new(codes::BAD_ARGS, "missing string arg `command`"))?
        .to_owned();
    let argv = args
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
    let cwd = args.get("cwd").and_then(Value::as_str).map(str::to_owned);
    Ok((command, argv, cwd))
}

impl Service for SubprocessService {
    fn service_name(&self) -> &str {
        "subprocess"
    }

    fn call(
        &self,
        method: &str,
        args: &Value,
        ctx: &CallContext,
        _sink: Arc<dyn FrameSink>,
    ) -> Result<Value, ServiceError> {
        match method {
            "runCollect" => self.run_collect(args, ctx),
            "spawn" => self.spawn_piped(args),
            other => Err(ServiceError::new(
                "bridge.no_method",
                format!("subprocess.{other} is not served in this migration phase"),
            )),
        }
    }

    fn owns(&self, id: &BridgeId) -> bool {
        self.streams
            .lock()
            .expect("streams lock must not poison")
            .contains_key(id)
            || self
                .processes
                .lock()
                .expect("processes lock must not poison")
                .contains_key(id)
    }

    fn open_stream(
        &self,
        id: &BridgeId,
        _resource_type: &str,
        credit_bytes: u32,
        ctx: &CallContext,
        sink: Arc<dyn FrameSink>,
    ) -> Result<(), ServiceError> {
        let Some(record) = self.find_stream(id) else {
            return Err(ServiceError::new(
                codes::UNKNOWN,
                format!("unknown stream {id:?}"),
            ));
        };
        record.credit.grant(credit_bytes);
        record.generation.store(ctx.generation, Ordering::SeqCst);
        let reader: Box<dyn Read + Send> = match record.kind {
            StreamKind::Stdout => {
                let mut stdout = record
                    .process
                    .stdout
                    .lock()
                    .expect("stdout lock must not poison");
                Box::new(stdout.take().ok_or_else(|| {
                    ServiceError::new(codes::UNKNOWN, format!("stream {id:?} already consumed"))
                })?)
            }
            StreamKind::Stderr => {
                let mut stderr = record
                    .process
                    .stderr
                    .lock()
                    .expect("stderr lock must not poison");
                Box::new(stderr.take().ok_or_else(|| {
                    ServiceError::new(codes::UNKNOWN, format!("stream {id:?} already consumed"))
                })?)
            }
        };
        self.pump(record, reader, sink);
        Ok(())
    }

    fn stream_credit(&self, id: &BridgeId, credit_bytes: u32) -> Result<(), ServiceError> {
        let Some(record) = self.find_stream(id) else {
            return Err(ServiceError::new(
                codes::UNKNOWN,
                format!("unknown stream {id:?}"),
            ));
        };
        record.credit.grant(credit_bytes);
        Ok(())
    }

    fn release_resource(&self, id: &BridgeId) -> Result<(), ServiceError> {
        if let Some(process) = self
            .processes
            .lock()
            .expect("processes lock must not poison")
            .remove(id)
        {
            process.cancel.store(true, Ordering::SeqCst);
            process.kill_tree();
        }
        Ok(())
    }

    fn on_cancel(&self, id: &BridgeId) {
        // Cancel the owning process tree whether the id is a process or a stream.
        let process = self
            .streams
            .lock()
            .expect("streams lock must not poison")
            .get(id)
            .map(|record| Arc::clone(&record.process))
            .or_else(|| {
                self.processes
                    .lock()
                    .expect("processes lock must not poison")
                    .get(id)
                    .cloned()
            });
        if let Some(process) = process {
            process.cancel.store(true, Ordering::SeqCst);
            process.kill_tree();
        }
    }

    fn shutdown(&self) {
        self.kill_all();
        // Join pumps so no thread outlives the connection.
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
