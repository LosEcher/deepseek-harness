# Agent Note: Rust capability providers behind Cordis

Status: implemented (P0 contracts+ledger, P1 product bridge); in progress (P2 persistence leaves); P3–P4 open; P5–P9 explicitly out of the default path. Progress ledger: `docs/rust-migration-matrix.md` (generated) + `.agents/notes/implemented/process/2026-08-15-rust-migration-ledger.md`.

English | [中文](2026-08-15-rust-host-replacement.zh.md)

## Problem

DeepSeek Harness is a Cordis plugin tree whose process root is Node. The product is replaceable Service Providers behind stable Service Definitions, plus three out-of-process protocols: SDK JSON-RPC, ACP, and Host `/api`. That structure already lets one execution world move without forking bash, PTY, or LSP ([portable consumers](../../implemented/architecture/2026-07-28-portable-execution-world-consumers.md)).

A host-language replacement that removes Node would also remove TypeScript `apply(ctx)`, HMR, `!!js` composition, and [`dsh-tool-cordis`](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md). Those are product extension behavior, not host accidents. Provider-only native modules — the Landlock launcher ([native architecture](../../../../native/landlock-run/docs/architecture.md)), packaged ripgrep, and koffi FFI — already show that a capability can move without taking the composer with it.

The repository is still pre-release, so on-disk formats may change, but the TypeScript plugin API and shipped composition rows are not a format the product may drop in order to rustify a backend.

## Proposal

Add Rust implementations behind the existing Service Definitions while Node remains the process root and Cordis remains the composer. A profile may default to a Rust provider only after conformance matches the TypeScript provider; the TypeScript provider and every `apply(ctx)` plugin stay loadable. Translating TypeScript plugins into Rust, or embedding a second JavaScript engine so Rust can be the root, is out of scope.

### Product topology

`dsh` still boots through Node and the Cordis Loader. Rust code lives in `native/dsh` and enters the tree only as an ordinary Cordis facade: the facade declares injections, acquires a sidecar or in-process addon inside `ctx.effect()`, registers the existing `ctx` key, converts `AbortSignal` to bridge cancellation, and awaits quiescence on dispose. Consumers keep importing the Service Definition package.

The sidecar child process carries filesystem, subprocess, sandbox, and PTY work that needs an owned process tree. Leaf primitives that are file replacement, locks, JSONL append, or session leases may later use an in-process native addon when a process hop is measurable overhead. The agent loop, prompt assembly, tool registry, and product plugins stay in the Node process so waterfall listeners keep shared object identity.

Agent isolation is a separate [worker-process proposal](2026-08-15-agent-worker-process-isolation.md). It first moves a complete TypeScript Agent composition into a Node child process; a Rust provider sidecar alone does not satisfy that proposal.

### Compatibility classes

P0 records a compatibility class for each observed interface instead of applying byte equality to every JSON document.

| Interface | Owner | Required compatibility |
|---|---|---|
| Session event envelope and persisted JSONL | [`dsh-session`](../../../../packages/core/session/README.md) and persistence providers | Canonical persisted rows remain byte-identical after normalization; reconstruction, unknown-event refusal, and `ignorable: true` remain semantically identical |
| SDK JSON-RPC | [`dsh-sdk-protocol`](../../../../packages/sdk/protocol/README.md) | Method names, params, results, errors, notification ordering, cancellation, and NDJSON framing remain compatible with both SDK clients |
| ACP | [`dsh-acp`](../../../../packages/acp/acp/README.md) | Protocol frames and automation behavior remain compatible with the ACP snapshot corpus |
| Host API | [`dsh-host-apiproxy`](../../../../packages/host/apiproxy/README.md) and Typert Remote definitions | Endpoint, named arguments, result and error schemas, authority, unary versus stream behavior, and ordering remain compatible with the existing client |
| Composition | app-boot, bundle patches, and plugin Config schemas | Ordered patch replacement, `disabled`, `isolate`, `!!js`, and HMR keep their TypeScript Loader meanings; Rust does not become a second composer |
| Product bridge | `dsh-bridge-protocol` | Versioned internal IPC between a Cordis facade and a Rust provider; it is not a public SDK |

The session schema stays an open envelope owned by TypeScript. Rust persistence code treats `{ type, seq, time, data, ignorable?, ...surfaceFields }` generically. TypeScript stack traces and Node-specific syscall wording are not compatibility promises unless an existing user-visible snapshot pins them.

`native/dsh/contracts/` holds generated JSON schemas, positive fixtures, and negative fixtures with a format version and source digest. TypeScript remains the semantic owner; a freshness check regenerates the artifacts and fails on a diff.

### Two-way compatibility constraints

Rust implementations are replacements, not destinations. Every Rust provider must stay switchable back to its TypeScript provider without residual state:

- **No orphaned state on rollback.** Persistent artifacts introduced by a Rust implementation — session lease files, log row formats, lock siblings — must be readable, validated, and cleanable by the TypeScript implementation, or explicitly handed over by the supervisor during drain-and-resume. Rolling back to TypeScript must never leave an unclaimed lease or a format the TypeScript side cannot consume.
- **Byte-aligned log formats.** Rust-written session JSONL rows must match the TypeScript `format.ts` row spec and zstd framing. Acceptance includes a bidirectional fixture: logs written by Rust are read unchanged by TypeScript, and vice versa.
- **One shared conformance corpus.** The capability conformance suite is one shared fixture set — one JSON case corpus with a runner on each side. Rust and TypeScript providers run the same corpus; switching a backend in either direction passes the same assembled snapshots.
- **Explicit rollback only.** Rolling back to a TypeScript provider is an explicit configured operation reported in diagnostics as the effective backend; it is never a hidden fallback.

### Product bridge

`dsh-bridge-protocol` is the product IPC for a Rust provider, not a migration scaffold. The public SDK, ACP, and Host protocols never tunnel through or expose bridge frames. The initial carrier is a child process's stdin and stdout using `Content-Length`-framed JSON; stderr is diagnostics-only. Byte chunks may use base64 until a measured throughput or allocation failure justifies a binary payload extension. The same bridge is also the Agent worker transport of the worker-process proposal: worker commands are `call` frames on an `agent` service and session-event notifications are `event/invoke` payloads, so Rust providers and Agent workers share one IPC primitive set.

| Operation | Required behavior |
|---|---|
| `call` / `reply` | Full-duplex, re-entrant request/response with exact service, method, arguments, result, and typed error |
| `cancel` | Idempotently aborts the owned request and all child resources; a completed request wins only when its terminal frame was sent first |
| `resource/open` / `resource/release` | Transfers an opaque handle while ownership stays with the creating process; disconnect releases every live handle |
| `stream/open` / `stream/chunk` / `stream/end` | Preserves per-stream order, terminal error or success, bounded buffering, receiver credit, and cancellation |
| `contribution/register` / `contribution/remove` | Registers services and event listeners under one plugin generation and removes them as one reversible effect |
| `event/invoke` | Carries serial, parallel, emit, or waterfall dispatch with the original event payload and scoped registration identity |
| `continuation/call` / `continuation/reply` | Implements one-shot waterfall `next()` so a Node listener can wrap a Rust provider, or a Rust provider can call back into Node, without sharing an object reference |
| `dispose` / `quiescent` | Stops new work, cancels or drains owned work, releases resources, and acknowledges only after complete quiescence |

A parallel event that relies on shared mutable object identity is not bridged; those listeners stay in the Node process. Role inversion (Rust as process root, Node as guest) is a laboratory fixture only and is not a product topology.

### Phases

Phases are sequential at their exit boundaries. A shipped profile does not default to a Rust provider until that phase is green. TypeScript providers remain in the tree.

| Phase | Owns | Exit |
|---|---|---|
| P0 contracts and ledger | Cargo workspace, generated fixtures, [migration ledger](../../implemented/process/2026-08-15-rust-migration-ledger.md) | Freshness and bidirectional fixture checks pass; profiles are unchanged |
| P1 product bridge | Framed IPC, lifecycle, streams, resources, callbacks, fault handling | Filesystem, subprocess, PTY, and waterfall fixtures pass on the Node-root pairing; profiles are unchanged |
| P2 persistence leaves | Atomic write, file lock, JSONL, SQLite, session leases | TypeScript coordinators may use Rust storage behind facades; a second writer cannot acquire one live session; TypeScript backends remain mountable |
| P3 execution world | `fs`, `subprocess`, and `sandbox` providers plus PTY in one sidecar | Shipped `web` and `headless` profiles may default to that Rust world; bash, PTY, and LSP Consumers stay TypeScript; the TypeScript local providers remain mountable |
| P4 measured providers | Only a streaming or query backend whose Node path has a recorded cost | Chunk order, retry, cancellation, and teardown match that backend's fixtures; no spine or product-plugin rewrite |

P5–P9 from the host-replacement plan — reimplementing the model-visible spine, rewriting product plugins, inverting the process root, replacing the web host, and removing Node — are not on the default path. Revisit only with a new Agent Note and a measured reason that this topology cannot meet.

Turn-switching steps 1 and 2, stuck-tool drain, and HMR stay TypeScript. Step 3 automatic continuation, if built, is built in TypeScript first so it is not implemented twice.

### Package and crate map

The unit of replacement is a Service Provider, not a Service Definition and not a Consumer. Definitions, tools, and the composer stay TypeScript. The generated [Rust migration matrix](../../../../docs/rust-migration-matrix.md) is the exhaustive package list; the tables below are the replacement policy.

Shipped Rust crates and the TypeScript they stand behind:

| Rust crate | Implements | TypeScript that stays | Carrier today |
|---|---|---|---|
| `dsh-bridge-protocol` | Versioned bridge messages, framing, handshake, lifecycle | None — new IPC | Used by the sidecar and its tests |
| `dsh-bridge-runtime` | Stdio connection, service registry, cancellation, dispose | None — new IPC | Used by the sidecar |
| `dsh-sidecar` | Prototype `fs`, `subprocess`, and PTY services | [`dsh-fs`](../../../../packages/fs/fs/README.md), [`dsh-subprocess`](../../../../packages/subprocess/subprocess/README.md), and the bash / PTY / LSP Consumers | Child process stdio |
| `dsh-primitives` | Branded string ids, atomic file replacement, writer lock | [`dsh-brand`](../../../../packages/util/brand/README.md) remains the type-only Definition; settings and credentials coordinators stay TypeScript | Prototype only; later in-process addon or sidecar |
| `dsh-session-store` | Exclusive session lease, JSONL append and replay | [`dsh-session`](../../../../packages/core/session/README.md) and [`dsh-session-persistence`](../../../../packages/session/session-persistence/README.md) stay TypeScript | Prototype only |
| [`landlock-run`](../../../../native/landlock-run/docs/architecture.md) | Existing C11 Landlock launcher | [`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.md) keeps calling it | Unchanged native helper |

Planned provider replacements. Each row keeps the Service Definition package on TypeScript:

| TypeScript provider | Target crate | Phase | TypeScript Definition that stays |
|---|---|---|---|
| [`dsh-atomic-write`](../../../../packages/util/atomic-write/README.md) | `dsh-primitives` | P2 (prototype) | None — this package is the primitive |
| [`dsh-session-persistence-jsonl`](../../../../packages/session/session-persistence-jsonl/README.md) | `dsh-session-store` | P2 (prototype) | `dsh-session-persistence` |
| [`dsh-session-persistence-sqlite`](../../../../packages/session/session-persistence-sqlite/README.md) | `dsh-session-store` | P2 | `dsh-session-persistence` |
| [`dsh-settings-file`](../../../../packages/settings/settings-file/README.md) | `dsh-primitives` for the durable file | P2 | `dsh-settings` |
| [`dsh-credentials-local`](../../../../packages/credentials/credentials-local/README.md) | `dsh-primitives` for the durable file | P2 | `dsh-credentials` |
| [`dsh-attachment-local`](../../../../packages/attachment/attachment-local/README.md) | store crate beside `dsh-primitives` | P2 | `dsh-attachment` |
| [`dsh-spill-local`](../../../../packages/spill/spill-local/README.md) | store crate beside `dsh-primitives` | P2 | `dsh-spill` |
| [`dsh-fs-local`](../../../../packages/fs/fs-local/README.md), [`dsh-fs-sandbox`](../../../../packages/fs/fs-sandbox/README.md) | `dsh-sidecar` / later `dsh-execution` | P3 | `dsh-fs` |
| [`dsh-subprocess-local`](../../../../packages/subprocess/subprocess-local/README.md) | `dsh-sidecar` / later `dsh-execution` | P3 | `dsh-subprocess` |
| [`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.md), [`dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.md) | `dsh-sidecar` plus `landlock-run` | P3 | `dsh-sandbox` |

Stay on TypeScript. No Rust clone is planned unless a later measured Agent Note opens one:

| Kind | Packages |
|---|---|
| Composer and host mechanisms | Cordis Loader, HMR, `!!js`, `tsx` source launch, Typert generator / loader / registry, [`dsh-tool-cordis`](../../../../packages/extensions/tool-cordis/README.md) |
| Model-visible spine | `dsh-session`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop`, `dsh-scope` |
| Product plugins | approval, commands, user-questions, subagent and in-process drivers, compaction, jobs, skill, workflow including `dsh-workflow-worker-thread`, goal, plan, todo |
| Consumers over the execution world | `dsh-tool-fs`, `dsh-tool-bash`, `dsh-bash-local`, `dsh-terminal-bash`, `dsh-lsp-stdio`, `dsh-tool-lsp` |
| Alternate execution world | `dsh-e2b`, `dsh-fs-e2b`, `dsh-subprocess-e2b` |

> **tool-fs 迁移输入契约（C4 stale-read 守卫增强，2026-09-01 已实施于 TS 侧）**：
> `dsh-tool-fs` 的 `edit` 工具在 Rust `replace` 实现中必须继承以下模型可见语义（属 P5「模型可见主干」一致性范畴）：
> 1. 编辑守卫：未读目标拒绝（`FS_NOT_OBSERVED`）、观察版本失配拒绝（`FS_STALE_VERSION`）；
> 2. **stale 自动重试**：版本失配时无条件重试一次（provider 锁内原子 read→match→write，对当前内容重新匹配）；
> 3. **差异行定位兜底**：自动重试仍失配（old_string 0/多命中）时，重读内容定位最接近行，错误携带 `closest content near line N: "<snippet>"` 供模型定位；
> 4. `replace_all` 场景同样适用；`write`（全量覆盖）不做自动重试（stale 拒绝是保护，防止覆盖外部修改）。
> 实现参考：`packages/fs/tool-fs/src/edit.ts`（`locateClosestLine` / `staleEditConflictError` / execute catch 路径），排期文档 `dsfolder/C4-STALE-READ-GUARD-PLAN-2026-08-30.md`。
| Product entries and clients | `dsh-acp`, SDK protocol / client / server, `dsh-host-apiproxy`, `dsh-host-webserver`, `apps/web`, `packages/client` |
| Measured later only | `dsh-llm-deepseek` and other adapters, web fetch/search, MCP, `dsh-session-query-sqlite` |

`migrated` on the ledger means the shipped default provider is Rust. The TypeScript provider package remains in the workspace and stays selectable from composition.

### Candidate work queue

| Order | Work | Exit condition |
|---|---|---|
| 1 | Benchmark `dsh-session-query-sqlite` on representative persisted and live corpora, recording query latency, Node event-loop delay, reconciliation throughput, cancellation latency, and resident memory | A P4 Agent Note opens `dsh-session-index` only when the measurements identify a material Node cost or an isolation requirement |
| 2 | Define the `dsh-session-index` facade and shared conformance corpus; TypeScript keeps the `SessionQuery` Definition, canonical session log, request semantics, and Consumers, while Rust owns only the disposable derived database, reconciliation, FTS execution, cursor generations, and query cancellation | Rust and TypeScript backends pass the same search, cursor invalidation, rebuild, cancellation, and explicit two-way switching cases without changing model-visible snapshots |
| 3 | Decide whether restartable or durable DAG execution is a product requirement; if it is, specify a versioned plain-data DAG representation and a separate Rust engine behind a complete capability | The proposal proves deterministic scheduling, bounded concurrency, cancellation, checkpoint recovery, and ordered TypeScript-owned session events without translating the current JavaScript worker or embedding another JavaScript runtime |
| 4 | Route the ACP, Codex, Claude Code, and DSH SDK subagent adapters through the P3 Rust subprocess Provider and measure process-tree cleanup, bounded output, cancellation, and adapter duplication | A separate `dsh-subagent-runner` is proposed only if protocol-neutral supervision remains duplicated after the shared subprocess Provider ships; continuable orchestration and provider protocols stay TypeScript |
| 5 | Replace the callback- and live-`Agent`-based jobs start API with a proposed plain-data job specification, owner identity, commands, observations, and recovery rules before considering a Rust backend | The new jobs proposal defines restart, cancellation, ownership, result delivery, and compatibility semantics without transferring callbacks or live objects across the process boundary |
| Deferred | Keep `agent-loop`, continuable subagent orchestration, the current JavaScript workflow engine, todo, and session projection in TypeScript; evaluate a compaction or projection compute kernel only after profiling isolates CPU work from LLM and same-tick coordination | A later measured Agent Note names the unmet product requirement, the isolated computation, and the conformance evidence before any row moves |

### Ledger

[`native/dsh/migration/package-map.json`](../../../../native/dsh/migration/package-map.json) is the machine-readable ledger and [`docs/rust-migration-matrix.md`](../../../../docs/rust-migration-matrix.md) is its generated human view, produced by [`scripts/gen-rust-migration-ledger.ts`](../../../../scripts/gen-rust-migration-ledger.ts). Maintainers edit [`native/dsh/migration/overrides.json`](../../../../native/dsh/migration/overrides.json). The [ledger Agent Note](../../implemented/process/2026-08-15-rust-migration-ledger.md) owns the generator. `removeAfter` is not a Node-removal gate; TypeScript implementations are not scheduled for deletion by this proposal.

### External design references (2026-08-23)

InstantDB (`instantdb/instant`, Apache-2.0; OpenAI acquired the team 2026-08-22; full analysis in `dsfolder/INSTANTDB-ANALYSIS-2026-08-23.md`) validates and sharpens two semantics this note touches. Both are reference shapes, not code to import — TypeScript stays the implementation order (Step 3 first), and Rust reimplementation happens only under the phased gates above.

- **Idempotent resume protocol (Step 3; any future P5 reimplementation).** InstantDB's client `SyncTable` protocol is the industry reference for exactly-once re-send over a reconnectable stream: every client message carries a client-generated `client-event-id` (server dedupes by it); each subscription holds a persisted `tx-id` cursor plus a server-issued `token`; on reconnect the client sends `resync-table {subscription-id, tx-id, token}` and the server resumes from that cursor (see `client/packages/core/src/SyncTable.ts` and `Connection.ts`). Step 3 chunk dedupe, the pending-marker dedupe, and any Rust reimplementation must match this shape: client-generated idempotency key + persisted cursor + server-side ordered dedupe.
- **Derived search/index projection (candidate work queue item 2).** InstantDB runs a multi-tenant triple store (EAV) on Postgres with managed columns, partial indexes for uniqueness, and count-min sketches to restore planner statistics. That pattern maps to `dsh-session-index`: a disposable derived database over the canonical session log with generated `(session_id, event_id, attr, value)` rows plus generated columns and indexes, instead of bespoke query endpoints; their query engine compiles shape queries into SQL plans (pg_hint_plan) — a precedent for compiling `SessionQuery` to SQL against the derived DB.

## Alternatives considered

**Replace the Node process root and remove the JavaScript runtime (the previous P5–P9 host-replacement plan).** Rejected as the completion condition: it withdraws `apply(ctx)`, HMR, `!!js`, and `dsh-tool-cordis`. Rust providers do not require that withdrawal.

**Translate TypeScript plugins into Rust, or find a Cordis-equivalent Rust crate.** Rejected: declaration merging, live `ctx`, waterfall `next()`, and reversible effects are TypeScript-host mechanisms. A translation would drop identity-sensitive listeners. No maintained Rust library reproduces that API.

**Use Bun, Deno, or an embedded V8/QuickJS as a permanent guest so Rust can be the root.** Rejected: that is a second JavaScript runtime, not a provider swap, and this tree's native addons (`node-pty`, koffi, Landlock) are Node-hosted. A guest remains a laboratory inversion fixture only.

**Keep the bridge temporary and freeze a smaller worker ABI before inversion.** Rejected under this topology: inversion is not planned, so the bridge is the product IPC for Rust providers. Guest-only contribution messages stay unused in production.

**Reimplement `session`, `agent-loop`, and product plugins in Rust for completeness.** Rejected without a measured Node-process cost: those packages are the extension surface. Moving them forces every listener across the bridge and recreates the host-replacement problem.

**N-API only, no sidecar.** Rejected as the sole carrier: filesystem, subprocess, sandbox, and PTY need an owned process tree and crash isolation. An in-process addon remains allowed for P2 leaves after a hop is measured.

**Create provider-specific CLI protocols.** Rejected: each wrapper would need its own cancellation, stream, error, and teardown rules. One bridge gives those rules one implementation.

**Use unary JSON-RPC and skip waterfall.** Rejected: PTY and subprocess expose live resources, and Node middleware must still wrap a Rust provider through `next()`.

**Rewrite the React client in Rust.** Rejected: the browser is already a separate process behind Host RPC.

## Acceptance criteria

- P0: generated fixtures and the ledger pair stay freshness-gated; profiles do not change.
- P1: Node-root bridge fixtures for filesystem, subprocess, PTY, cancellation, waterfall `next()`, and dispose pass; no shipped profile loads the sidecar by default until P3.
- P2: Rust storage leaves pass focused conformance; session leases reject a second writer; TypeScript persistence backends remain mountable; shadow comparison never double-writes production state.
- P3: a shipped profile may default to the Rust execution world only after assembled snapshots pass; bash, PTY, and LSP Consumers are unchanged; the TypeScript local providers remain mountable.
- P4 occurs only with a recorded measurement and a provider-specific facade; it does not move the spine or product plugins.
- `apply(ctx)`, HMR, `!!js`, Typert, `tsx` source launch, `dsh-tool-cordis`, and the TypeScript SDK/ACP/Host clients remain product APIs.
- The generated package matrix names every DSH package and, for each default-Rust provider, the target crate, fixtures, placement, phase, and the TypeScript Definition that stayed.

## Risks

- **Two semantic owners.** Hand-maintained Rust and TypeScript schemas would drift. P0 permits one TypeScript owner and generated derivatives only.
- **Distributed waterfall deadlock.** Nested `next()` across the bridge requires re-entrant frame processing and one-shot continuation ownership. Listeners that need shared mutable identity stay in Node.
- **Unbounded bridge memory.** Receiver credit, bounded queues, cancellation priority, and process-death cleanup are protocol requirements.
- **Shadow side effects.** Stateful comparisons use isolated directories or disposable databases; production state is never dual-written.
- **Isolation is a vacuum, not a check.** `scripts/verify-native-dsh-boundary.ts` refuses shipped compositions that name Rust migration packages until a facade is allow-listed with its own conformance suite.
- **Snapshot lock-in of TypeScript accidents.** Only public text and specified order are compatibility requirements.
- **Session split brain.** A lease is exclusive; a second writer cannot acquire a live session. The Node coordinator still owns when to take or release that lease.
- **Dual CI cost.** Cargo and Node suites both stay required for every default-Rust provider.
- **Bridge ossification.** The full message set stays available for facades; production providers should use `call`, `cancel`, `stream`, `resource`, and `dispose` unless a facade actually registers a contribution.
- **Native launcher scope.** Landlock remains the existing C11 executable. This proposal does not rewrite it.
