# Agent Note: Rust host replacement of the Node runtime

Status: proposed

English | [中文](2026-08-15-rust-host-replacement.zh.md)

## Problem

DeepSeek Harness is a Cordis plugin tree whose process root is Node. The product is replaceable Service Providers behind stable Service Definitions, plus three out-of-process protocols — SDK JSON-RPC, ACP, and Host `/api`. That structure already lets one execution world move without forking bash, PTY, or LSP ([portable consumers](../../implemented/architecture/2026-07-28-portable-execution-world-consumers.md)). It does not let the host process itself leave Node.

A whole-tree TypeScript-to-Rust rewrite would throw away the plugin composition model, the session log, and the existing snapshot corpus. Provider-only native modules — the Landlock launcher ([native architecture](../../../../native/landlock-run/docs/architecture.md)), packaged ripgrep, koffi FFI — improve hot paths but leave Node as the root, so they cannot complete a replacement.

The repository is still pre-release: backends may refuse old on-disk formats, and `SESSION_FORMAT_VERSION` stays at `0` ([session log versioning](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)). That window is the only time a host-language change can keep the same product identity.

## Proposal

Replace the Node host with a Rust binary while keeping the browser client, the Python and TypeScript SDK clients, and the existing session and wire JSON. A replacement that cannot replay current keyless snapshots is a different harness, not this one.

### Replacement target

Done means every product entry — headless, ACP, and the web host that serves `apps/web` — is the same Rust binary, and the user's runtime closure contains no Node. Repository development tools (vitest, doc-sync, the documentation website) may stay TypeScript.

Out of scope: rewriting the React client, cloning Cordis HMR, cloning Typert, evaluating `!!js` in the Rust composer, and hot-compiling model-written plugins (`dsh-tool-cordis`, [self-referential toolset](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)).

### Frozen wire contracts

These JSON documents stay bit-compatible across the language change. A CI check compares TypeScript types to Rust crate fixtures in both directions.

| Contract | Owner | What pins it |
|---|---|---|
| Session events | [`dsh-session`](../../../../packages/core/session/README.md) | `deriveMessages()`, persistence, UI, SDK notifications |
| SDK JSON-RPC | [`dsh-sdk-protocol`](../../../../packages/sdk/protocol/README.md) | Python SDK, TypeScript SDK ([SDK note](../../implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md)) |
| ACP | [`dsh-acp`](../../../../packages/acp/acp/README.md) | Editor automation and ACP snapshots |
| Host RPC | [`dsh-host-apiproxy`](../../../../packages/host/apiproxy/README.md) | Existing React client ([GUI RPC](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)) |

Composition YAML keeps `id`, `name`, `config`, `disabled`, and `isolate`. `!!js` expressions become explicit overlays; the Rust composer does not evaluate JavaScript.

### Process inversion

Until the process root moves, Node remains the product. Replacement therefore has two mechanical phases, not a single rewrite.

While Node is the root, Rust crates implement Service Providers and later the spine (`session`, `llm`, `system-prompt`, `tools`, `agent`, `agent-loop`). TypeScript packages become facades that register the same `ctx` keys ([capability seams](../../implemented/architecture/2026-06-13-capability-seams.md)).

Then a Rust `dsh-runtime` becomes the root. It loads the crates directly, speaks the frozen wires, and may spawn a time-boxed JS guest for plugins not yet ported. Headless, ACP, and the SDK server move first. The web host moves after Host RPC is reimplemented against the same `/api` contract.

### Replacement layers

Layers are sequential. A layer that has not met its exit in Acceptance criteria does not start the next layer.

| Layer | Owns | Exit |
|---|---|---|
| L0 contract crates | `native/dsh` workspace: `dsh-session`, `dsh-llm-types`, `dsh-sdk-wire`, `dsh-host-wire`, `dsh-acp-wire`, `dsh-compose` | Bidirectional JSON goldens are red on drift; no product profile changes behavior |
| L1 capability crates | Landlock launcher under the existing CLI contract; `fs` / `subprocess` / `sandbox` as one execution world; session persistence and query SQLite | Shipped `web` and `headless` profiles use the Rust providers by default; bash, PTY, and LSP packages stay unchanged |
| L2 spine crates | The tree in [`dsh-agent-spine-demo`](../../../../packages/examples/agent-spine-demo/README.md), in order: session store and `deriveMessages()`, DeepSeek adapter, system-prompt, tools and `tools/*` waterfalls, agent registry and inbox, `agent-loop` | Named headless snapshots are byte-identical between the Rust loop and the TypeScript loop |
| L3 invert the process root | `dsh-runtime` serves headless, ACP, and SDK JSON-RPC; no HMR, Typert, or `dsh-tool-cordis` | Those three entries run as the Rust binary; ACP snapshots pass; the Python SDK can `session/prompt` against it |
| L4 remaining base rows and the web host | Settings, credentials, approval, commands, compaction, subagent, web/MCP, workflow/goal/plan/todo, then Host RPC plus static `apps/web` dist | `dsh --profile web` serves the existing frontend from the Rust host |
| L5 remove Node from the product | Delete the JS guest; drop Node from release artifacts and user runtime docs | Snapshot and assembled e2e jobs invoke only the Rust host |

L1 prefers argv/exec binaries in the Landlock packaging style ([native/](../../../../native/README.md)) until a measured latency requirement forces an in-process addon. An addon that needs the Node ABI cannot survive L5.

`fs` and `subprocess` move as a pair. Containers and microVMs are not `ctx.sandbox` backends ([sandbox decision](../../implemented/feature/2026-07-06-sandbox.md)).

### Plugin model

Official plugins are Rust crates compiled into the binary. Composition remains a YAML table. Third-party `dylib` plugins are deferred until the official set is complete.

The Rust runtime implements service registration, `inject` readiness, reversible effects, and waterfall/serial/parallel dispatch as explicit traits. It does not clone TypeScript declaration merging or HMR.

`dsh-tool-cordis` live mount is dropped at L3. A later WASM or DSL plugin host is a new proposal, not a requirement of this one.

Typert does not move. Host RPC on the Rust host uses the frozen `/api` JSON, not a type-graph generator.

### Inventory

Replace the implementation and keep the Service Definition: `fs` / `fs-local` / `fs-sandbox`, `subprocess` / `subprocess-local`, `sandbox` / `sandbox-local` / `sandbox-windows-acl`, session persistence JSONL and SQLite, `session-query-sqlite`, `llm-deepseek` and later adapters, web fetch/search, `attachment-local`, `spill-local`, `settings-file`, `credentials-local`.

Reimplement with identical semantics: `session`, `system-prompt`, `tools`, `agent`, `agent-loop`, `scope`, `approval`, `commands`, `user-questions`, `subagent` and in-process providers, `compaction`, `jobs`, `skill`, `host-apiproxy`, `webserver`, `frontend-static`.

Do not port: HMR, Typert, `!!js`, `dsh-tool-cordis` live mount, `tsx` source launch, the Node `workflow-worker-thread` engine (replace with a native or separate-process engine when that row moves).

Keep on the TypeScript side permanently: `apps/web` and `packages/client`, the Python and TypeScript SDK clients, the documentation website, and snapshot recorders that already speak the frozen wires.

## Alternatives considered

**Rewrite Cordis, the loop, and the web client in one effort.** Rejected: the plugin tree, session reconstruction, and snapshot corpus are the product. A green-field Rust harness would fork identity immediately.

**Stop after native Service Providers (L1 as the end state).** Rejected: that is the current Landlock/ripgrep/koffi pattern. It never removes Node from the process root.

**Embed a JavaScript engine permanently so TypeScript plugins keep loading.** Rejected as the completion condition: a permanent guest is a dual runtime, not a replacement. A time-boxed guest is allowed only through L4.

**Clone Cordis declaration merging and HMR in Rust.** Rejected: those are TypeScript-host mechanisms. The replacement keeps the plugin ideas (services, inject, effects, waterfalls) and drops the TypeScript-specific machinery.

**Treat containers or microVMs as `ctx.sandbox` backends.** Rejected by the existing sandbox decision: those replace the `fs` and `subprocess` execution world, not the same-world confinement runner.

**Rewrite the React client in Rust.** Rejected: the browser is already a separate process behind Host RPC. Replacing it is a different product.

## Acceptance criteria

- L0: `native/dsh` crates exist; a CI check fails if TypeScript session/SDK/ACP/Host JSON fixtures disagree with the crate goldens in either direction; no product profile changes behavior.
- L1: shipped `web` and `headless` profiles use the Rust filesystem, subprocess, and sandbox providers by default; existing `fs`, sandbox, and `partial-landlock` tests and snapshots pass; bash, PTY, and LSP packages are unchanged.
- L2: `examples/headless-agent` `headless-profile` and at least one tool snapshot produce a byte-identical session log from the Rust loop and the TypeScript loop; cancel, drain, resume, and empty-turn rejection match.
- L3: the headless, ACP, and SDK entry points run as `dsh-runtime`; existing ACP snapshots pass; the Python SDK can `session/prompt` against that binary.
- L4: `dsh --profile web` serves the existing `apps/web` dist from the Rust host; existing web e2e suites pass against that host without a required frontend rewrite.
- L5: product documentation and release artifacts have no Node runtime dependency; the JS guest is absent; snapshot and assembled e2e jobs invoke only the Rust host.

## Risks

- **Two harnesses.** If crate JSON drifts from TypeScript types, snapshots will pass on one host and fail on the other. The L0 bidirectional golden is the control; a layer may not proceed while that check is red.
- **Snapshot lock-in of TypeScript accidents.** Some fixtures may encode Node-specific timing or error strings. Fix the fixture only when the string is not user-visible product text; otherwise the Rust host must emit the same text.
- **Plugin authors lose TypeScript `apply(ctx)`.** Accepted for completion. Official plugins move as crates. Out-of-tree TypeScript plugins need the guest until L5, then a later dylib/WASM proposal.
- **Dropping `dsh-tool-cordis` removes self-modification.** Accepted at L3. Reintroduction requires a sandboxable plugin format, not rustc in the product binary.
- **Same-process native addons (napi).** Prefer argv/exec binaries in the Landlock packaging style until a measured latency requirement forces an in-process addon. Addons import Node ABI into a host that this proposal is trying to delete.
- **The JS guest becomes permanent.** L5 forbids shipping it. A layer that still needs the guest has not finished.
