# Native DSH runtime

English | [中文](README.zh.md)

This isolated Cargo workspace implements the product bridge and Rust Service Providers that a Node Cordis facade may mount. No shipped profile loads it. The Node process remains the product root.

## Contents

- `contracts/` contains the versioned bridge manifest and positive and negative JSON fixtures.
- `crates/dsh-bridge-protocol/` owns bridge messages, Content-Length framing, handshake validation, typed remote errors, stream credit, generation-scoped resources and continuations, and dispose/quiescence state checks.
- `crates/dsh-bridge-runtime/` is the symmetric connection runtime: frame reader/writer over stdio, handshake exchange, the service registry, per-request cancellation, and the dispose/quiescence sequence.
- `crates/dsh-primitives/` owns the P2 leaf primitives: branded string ids, atomic file replacement, and the exclusive writer lock.
- `crates/dsh-session-store/` owns the P2 persistence primitives: exclusive session leases (a second writer cannot acquire a live session) and JSONL append/replay.
- `migration/package-map.json` is the generated machine-readable ledger of every DSH package; [`docs/rust-migration-matrix.md`](../../docs/rust-migration-matrix.md) is its human view.
- `crates/dsh-sidecar/` is the first-party sidecar executable with the P1 execution-world prototypes: `fs.resolve` / `fs.readText` / `fs.writeTextAtomic` (alias identity, missing targets, cancellation, atomic mutation in an isolated directory), `subprocess.runCollect` / `subprocess.spawn` (collect with spill, credit-bounded piped streams, process-tree termination), `pty.open` / `pty.write` / `pty.resize` / `pty.signal` (ordered I/O, resize, signals, session quiescence), `test.waterfall` (contribution round-trip, next()/wrap/short-circuit, stale-continuation rejection), and `test.sleep`. `DSH_BRIDGE_ROLE=rust_root` runs the sidecar as RustRoot so the same fixture batch passes under both the Node-root and inverted JsGuest pairings.

## Checks

```sh
cd native/dsh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

`cargo test --workspace` spawns the real sidecar over pipes and verifies the wire protocol end to end: handshake, fs resolves and reads, cancellation, atomic writes, unsupported request kinds, and a clean dispose/quiescent exit.

The workspace does not yet provide a TypeScript Cordis facade. The [Rust capability-provider Agent Note](../../.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md) owns the phases and acceptance criteria.
