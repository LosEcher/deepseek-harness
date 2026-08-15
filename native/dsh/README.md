# Native DSH runtime

English | [中文](README.zh.md)

This isolated Cargo workspace implements the protocol and schema foundation for replacing the product's Node host with Rust. No shipped profile loads it.

## Contents

- `contracts/` contains the versioned bridge manifest and positive and negative JSON fixtures.
- `crates/dsh-bridge-protocol/` owns bridge messages, Content-Length framing, handshake validation, typed remote errors, stream credit, generation-scoped resources and continuations, and dispose/quiescence state checks.

## Checks

```sh
cd native/dsh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

The workspace does not yet provide a sidecar executable, TypeScript Cordis facade, filesystem provider, subprocess provider, or PTY provider. The [Rust host replacement Agent Note](../../.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md) owns the migration phases and acceptance criteria.
