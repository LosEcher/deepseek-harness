//! Rust migration-bridge sidecar executable.
//!
//! Runs a bridge connection on stdio with the first-party capability
//! services registered. Nothing is written to stdout except protocol frames;
//! diagnostics go to stderr. The process exits 0 only after a clean
//! dispose/quiescent exchange.

use dsh_bridge_protocol::{manifest_source_digest, BridgeRole, Hello, PROTOCOL_VERSION};
use dsh_bridge_runtime::{serve, BridgeConfig, MapRegistry, SideExit};
use std::process::ExitCode;
mod fs;
mod pty;
mod subprocess;
mod test;

const CAPABILITIES: &[&str] = &[
    "fs.resolve",
    "fs.readText",
    "fs.writeTextAtomic",
    "subprocess.runCollect",
    "subprocess.spawn",
    "pty.open",
    "pty.write",
    "pty.resize",
    "pty.signal",
    "test.sleep",
];

fn main() -> ExitCode {
    let generation: u64 = std::env::var("DSH_BRIDGE_GENERATION")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let build = format!(
        "dsh-sidecar {} ({} profile)",
        env!("CARGO_PKG_VERSION"),
        option_env!("PROFILE").unwrap_or("dev")
    );

    let registry = MapRegistry::new();
    registry.register(std::sync::Arc::new(fs::FsService::new()));
    registry.register(std::sync::Arc::new(pty::PtyService::new()));
    registry.register(std::sync::Arc::new(subprocess::SubprocessService::new()));
    registry.register(std::sync::Arc::new(test::TestService::new()));

    let config = BridgeConfig {
        hello: Hello {
            bridge_version: PROTOCOL_VERSION,
            generation,
            role: BridgeRole::RustSidecar,
            build,
            schema_digest: manifest_source_digest(),
            capabilities: CAPABILITIES.iter().map(|item| item.to_string()).collect(),
        },
        required_peer_capabilities: Vec::new(),
        services: std::sync::Arc::new(registry),
        max_frame_size: dsh_bridge_protocol::DEFAULT_MAX_FRAME_SIZE,
    };

    let exit = match serve(std::io::stdin(), std::io::stdout(), config) {
        Ok(SideExit::Quiescent) => {
            eprintln!("dsh-sidecar: quiescent, exiting");
            ExitCode::SUCCESS
        }
        Ok(SideExit::Abnormal) => {
            eprintln!("dsh-sidecar: connection ended without dispose");
            ExitCode::from(2)
        }
        Err(error) => {
            eprintln!("dsh-sidecar: {error}");
            ExitCode::from(1)
        }
    };
    exit
}
