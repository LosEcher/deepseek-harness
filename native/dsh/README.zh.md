# 原生 DSH 运行时

[English](README.md) | 中文

这个隔离的 Cargo workspace 实现以 Rust 替换产品 Node 宿主所需的协议与 schema 基础。当前没有已发布 profile 加载它。

## 内容

- `contracts/` 包含带版本的 bridge manifest 以及 JSON 正向和负向 fixture。
- `crates/dsh-bridge-protocol/` 负责 bridge 消息、Content-Length framing、握手校验、类型化远端错误、stream credit、按 generation 管理的资源与 continuation，以及 dispose/quiescence 状态检查。
- `crates/dsh-bridge-runtime/` 是对称连接运行时：stdio 上的 frame 读写、握手交换、服务注册表、按请求取消，以及 dispose/quiescence 序列。
- `crates/dsh-sidecar/` 是第一方 sidecar 可执行文件，带 P1 执行世界原型：`fs.resolve` / `fs.readText` / `fs.writeTextAtomic`（alias identity、目标不存在、取消、隔离目录中的原子 mutation）以及 `test.sleep` 取消探针。

## 检查

```sh
cd native/dsh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

`cargo test --workspace` 通过管道启动真实 sidecar，并端到端验证线上协议：握手、fs resolve 与读取、取消、原子写入、不支持的请求种类，以及干净的 dispose/quiescent 退出。

该 workspace 尚不提供 TypeScript Cordis facade、subprocess provider 或 PTY provider。迁移阶段和验收标准由 [Rust 宿主替换 Agent Note](../../.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md)负责。
