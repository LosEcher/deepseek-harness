# Native DSH runtime

English | [中文](README.zh.md)

This isolated Cargo workspace implements the protocol and schema foundation for replacing the product's Node host with Rust. No shipped profile loads it.

## Contents

- `contracts/` contains the versioned bridge manifest and positive and negative JSON fixtures.
- `crates/dsh-bridge-protocol/` owns bridge messages, Content-Length framing, handshake validation, typed remote errors, stream credit, generation-scoped resources and continuations, and dispose/quiescence state checks.
- `crates/dsh-bridge-runtime/` is the symmetric connection runtime: frame reader/writer over stdio, handshake exchange, the service registry, per-request cancellation, and the dispose/quiescence sequence.
- `crates/dsh-sidecar/` is the first-party sidecar executable with the P1 execution-world prototypes: `fs.resolve` / `fs.readText` / `fs.writeTextAtomic` (alias identity, missing targets, cancellation, atomic mutation in an isolated directory) and a `test.sleep` cancellation probe.

## Checks

```sh
cd native/dsh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

`cargo test --workspace` spawns the real sidecar over pipes and verifies the wire protocol end to end: handshake, fs resolves and reads, cancellation, atomic writes, unsupported request kinds, and a clean dispose/quiescent exit.

The workspace does not yet provide a TypeScript Cordis facade, subprocess provider, or PTY provider. The [Rust host replacement Agent Note](../../.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md) owns the migration phases and acceptance criteria.
