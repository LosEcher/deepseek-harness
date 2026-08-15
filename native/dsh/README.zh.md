# 原生 DSH 运行时

[English](README.md) | 中文

这个隔离的 Cargo workspace 实现以 Rust 替换产品 Node 宿主所需的协议与 schema 基础。当前没有已发布 profile 加载它。

## 内容

- `contracts/` 包含带版本的 bridge manifest 以及 JSON 正向和负向 fixture。
- `crates/dsh-bridge-protocol/` 负责 bridge 消息、Content-Length framing、握手校验、类型化远端错误、stream credit、按 generation 管理的资源与 continuation，以及 dispose/quiescence 状态检查。

## 检查

```sh
cd native/dsh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

该 workspace 尚不提供 sidecar 可执行文件、TypeScript Cordis facade、文件系统 provider、subprocess provider 或 PTY provider。迁移阶段和验收标准由 [Rust 宿主替换 Agent Note](../../.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md)负责。
