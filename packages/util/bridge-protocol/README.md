# dsh-bridge-protocol

English | [中文](README.zh.md)

Versioned product-bridge messages, LSP-compatible Content-Length framing, and handshake pairing. TypeScript owns the semantics; the Rust `dsh-bridge-protocol` crate consumes the same JSON.

It is a library, not a service: no `ctx` key, no plugin registration. Agent workers and Rust provider facades share this message set. The public SDK, ACP, and Host protocols never tunnel through it.

## Roles

`node_root` pairs with `rust_sidecar` or `node_worker`. `rust_root` pairs with `js_guest`. A Hello must carry a non-zero generation, a non-empty build id, the expected schema digest, and any required capabilities.

## Framing

Each frame is `Content-Length: <n>\r\n\r\n` plus a UTF-8 JSON body. The decoder accepts arbitrary chunk boundaries and rejects headers larger than 4096 bytes and bodies larger than 16 MiB.

## Known Limitations and Deferred Work

- **JSON carrier only** — byte payloads stay base64 until a measured throughput failure justifies a binary extension.
- **Role inversion is laboratory-only** — `rust_root` / `js_guest` pairing is not a product topology.
