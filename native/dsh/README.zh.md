# 原生 DSH 运行时

[English](README.md) | 中文

这个隔离的 Cargo workspace 实现产品 bridge，以及 Node Cordis facade 可以挂载的 Rust Service Provider。当前没有已发布 profile 加载它。Node 进程仍是产品根。

## 内容

- `contracts/` 包含带版本的 bridge manifest 以及 JSON 正向和负向 fixture。
- `crates/dsh-bridge-protocol/` 负责 bridge 消息、Content-Length framing、握手校验、类型化远端错误、stream credit、按 generation 管理的资源与 continuation，以及 dispose/quiescence 状态检查。
- `crates/dsh-bridge-runtime/` 是对称连接运行时：stdio 上的 frame 读写、握手交换、服务注册表、按请求取消，以及 dispose/quiescence 序列。
- `crates/dsh-primitives/` 负责 P2 叶子原语：带品牌的字符串 id、原子文件替换，以及独占 writer lock。
- `crates/dsh-session-store/` 负责 P2 持久化原语：独占 session lease（第二个 writer 无法获取仍被占用的 session）以及 JSONL 追加／回放。
- `migration/package-map.json` 是每个 DSH 包的生成机器可读 ledger；[`docs/rust-migration-matrix.md`](../../docs/rust-migration-matrix.md) 是其人类视图。
- `crates/dsh-sidecar/` 是第一方 sidecar 可执行文件，带 P1 执行世界原型：`fs.resolve` / `fs.readText` / `fs.writeTextAtomic`（alias identity、目标不存在、取消、隔离目录中的原子 mutation）、`subprocess.runCollect` / `subprocess.spawn`（带 spill 的 collect、受 credit 约束的 piped stream、进程树终止）、`pty.open` / `pty.write` / `pty.resize` / `pty.signal`（有序 I/O、resize、signal、session 停稳）、`test.waterfall`（contribution 往返、next()/包装/短路、迟到 continuation 拒绝），以及 `test.sleep`。设置 `DSH_BRIDGE_ROLE=rust_root` 让 sidecar 以 RustRoot 运行，同一批 fixture 在 Node-root 与倒置的 JsGuest 两种配对下都通过。

## 检查

```sh
cd native/dsh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

`cargo test --workspace` 通过管道启动真实 sidecar，并端到端验证线上协议：握手、fs resolve 与读取、取消、原子写入、不支持的请求种类，以及干净的 dispose/quiescent 退出。

该 workspace 尚不提供 TypeScript Cordis facade。阶段和验收标准由 [Rust 能力 Provider Agent Note](../../.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md)负责。
