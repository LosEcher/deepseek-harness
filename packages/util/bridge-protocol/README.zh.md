# dsh-bridge-protocol

[English](README.md) | 中文

带版本的产品 bridge 消息、兼容 LSP 的 Content-Length framing，以及握手配对。语义由 TypeScript 拥有；Rust 的 `dsh-bridge-protocol` crate 消费同一套 JSON。

这是库而不是服务：没有 `ctx` key，也不做插件注册。Agent worker 与 Rust provider 门面共用这一套消息。公开的 SDK、ACP 和 Host 协议从不经由它隧道传输。

## 角色

`node_root` 与 `rust_sidecar` 或 `node_worker` 配对。`rust_root` 与 `js_guest` 配对。Hello 必须携带非零 generation、非空 build id、期望的 schema digest，以及所需 capabilities。

## Framing

每帧为 `Content-Length: <n>\r\n\r\n` 加上 UTF-8 JSON 正文。解码器接受任意分块边界，并拒绝超过 4096 字节的头和超过 16 MiB 的正文。

## Known Limitations and Deferred Work

- **仅 JSON 载体** — 字节载荷保持 base64，直到实测吞吐失败才引入二进制扩展。
- **角色反转仅用于实验室** — `rust_root` / `js_guest` 配对不是产品拓扑。
