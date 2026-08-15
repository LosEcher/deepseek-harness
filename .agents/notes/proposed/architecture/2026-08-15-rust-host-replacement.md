# Agent Note: Rust host replacement of the Node runtime

Status: proposed

English | [中文](2026-08-15-rust-host-replacement.zh.md)

## Problem

DeepSeek Harness is a Cordis plugin tree whose process root is Node. The product is replaceable Service Providers behind stable Service Definitions, plus three out-of-process protocols: SDK JSON-RPC, ACP, and Host `/api`. That structure already lets one execution world move without forking bash, PTY, or LSP ([portable consumers](../../implemented/architecture/2026-07-28-portable-execution-world-consumers.md)). It does not let the host process itself leave Node.

A whole-tree TypeScript-to-Rust rewrite would throw away the plugin composition model, the session log, and the existing snapshot corpus. Provider-only native modules, including the Landlock launcher ([native architecture](../../../../native/landlock-run/docs/architecture.md)), packaged ripgrep, and koffi FFI, improve individual paths but leave Node as the root, so they cannot complete a replacement.

The repository is still pre-release: backends may refuse old on-disk formats, and `SESSION_FORMAT_VERSION` stays at `0` ([session log versioning](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)). This window permits a host-language change without promising compatibility with every intermediate implementation, but the final runtime must preserve the product's observable protocols, reconstruction rules, and extension behavior.

## Proposal

Replace the Node host with one Rust binary while keeping the browser client, the Python and TypeScript SDK clients, and the existing durable and network protocols. A replacement that cannot replay the current keyless snapshots is a different harness, not this one.

### Replacement target

Done means every product entry, including headless, ACP, SDK JSON-RPC, and the web host that serves `apps/web`, runs from the same Rust binary, and the user's runtime closure contains no Node. Repository development tools such as Vitest, doc-sync, the documentation website, TypeScript SDK builds, and snapshot recorders may stay TypeScript.

The migration unit is a capability closure, not an npm package. A crate may be implemented independently, but a profile switches only after its Service Definition, Service Provider, Consumers, durable effects, cancellation, and teardown behavior pass one conformance suite. `fs`, `subprocess`, and `sandbox` therefore move as one execution world; `session`, `system-prompt`, `tools`, `agent`, and `agent-loop` move as the model-visible spine.

Out of scope: rewriting the React client, cloning Cordis HMR, evaluating arbitrary JavaScript in the Rust composer, or hot-compiling model-written Rust plugins. Typert remains a build-time source for the Host endpoint manifest rather than becoming a Rust runtime, and `dsh-tool-cordis` remains available only while the Node-root or temporary JS-guest phase can host it ([self-referential toolset](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)).

### P0: protocol and schema foundation

P0 creates `native/dsh/` as a Cargo workspace without changing any product profile. Existing TypeScript owners remain authoritative until the corresponding implementation moves; generators under `scripts/` emit checked-in fixtures and manifests consumed by Rust tests. A protocol has one semantic owner at a time: Rust does not hand-maintain a second copy of a TypeScript union or endpoint list.

#### Compatibility classes

P0 records a compatibility class for each observed interface instead of applying byte equality to every JSON document.

| Interface | P0 owner | Required compatibility |
|---|---|---|
| Session event envelope and persisted JSONL | [`dsh-session`](../../../../packages/core/session/README.md) and persistence providers | Canonical persisted rows remain byte-identical after normalization; reconstruction, unknown-event refusal, and `ignorable: true` remain semantically identical |
| SDK JSON-RPC | [`dsh-sdk-protocol`](../../../../packages/sdk/protocol/README.md) | Method names, params, results, errors, notification ordering, cancellation, and NDJSON framing remain compatible with both SDK clients |
| ACP | [`dsh-acp`](../../../../packages/acp/acp/README.md) | Protocol frames and automation behavior remain compatible with the ACP snapshot corpus |
| Host API | [`dsh-host-apiproxy`](../../../../packages/host/apiproxy/README.md), Typert Remote definitions, and the GUI RPC decision | Endpoint, named arguments, result and error schemas, authority, unary versus stream behavior, and ordering remain compatible with the existing client |
| Composition | app-boot, bundle patches, and plugin Config schemas | Ordered patch replacement, activation dependencies, config validation, `disabled`, `isolate`, and explicit runtime-value references have deterministic Rust and TypeScript interpretations |
| Migration bridge | `dsh-bridge-protocol` | Internal, versioned compatibility only between adjacent migration phases; it is not a public SDK or third-party plugin promise |

The session schema is an open envelope, not a closed Rust enum. Rust represents `{ type, seq, time, data, ignorable?, ...surfaceFields }` generically, dispatches known `type` values through registered codecs and folders, and may expose typed views for first-party events. An unknown event without `ignorable: true` refuses reconstruction; an unknown ignorable event remains in the raw log and is skipped only by projections that do not understand it.

The Host manifest is generated from the static `ApiProxy` definitions and Typert Remote metadata. It records each endpoint's service, method, exact named arguments, result schema, error identities, authority, and carrier mode. Typert remains in the build plane; the Rust host loads the generated manifest and dispatch table. A process or WASM plugin that contributes Host endpoints must declare the same metadata in its plugin manifest rather than relying on runtime TypeScript reflection.

Composition v1 replaces arbitrary `!!js` expressions with tagged data nodes for environment lookup, platform selection, runtime paths such as cwd and Harness home, schema-declared JSON startup values exposed by injected services, and CLI-supplied overlays. Each node defines its evaluation phase, missing-value failure, and result type; it cannot inspect an arbitrary service object. The existing `id`, `name`, `config`, `disabled`, and `isolate` row fields remain, but Rust does not execute JavaScript. P0 inventories every shipped `!!js` expression and proves that composition v1 can represent it before any profile switches composer.

#### Generated artifacts and conformance

`native/dsh/contracts/` contains generated JSON schemas, endpoint and event manifests, positive fixtures, and negative fixtures. Each artifact carries a format version and source digest. A freshness check regenerates them from the TypeScript owners and fails on a diff; Rust tests decode the positive set, reject the negative set with the named error class, and encode values that the TypeScript verifier reads back.

The conformance runner distinguishes canonical bytes from semantics. Session storage and any protocol text explicitly defined as canonical compare normalized bytes. SDK, ACP, Host, cancellation, and lifecycle cases compare decoded frames, ordering, error identity, and terminal state. Timestamps, opaque ids, temporary paths, and transport chunk boundaries are normalized only where the existing snapshot policy already treats them as volatile.

P0 captures the already-implemented TypeScript turn-switching behavior as the P5 oracle: a durable `turn/pending` row, repair that does not synthesize an `interrupted` closer for that turn, and the shutdown flush fence that persists the marker before teardown. It also records phase-scoped P5 scenarios for automatic continuation, a durable continuation cursor, and duplicate `assistant/chunk` suppression. Those future scenarios are freshness-gated in P0 but become required executable conformance cases only when P5 takes ownership; they do not pretend that TypeScript already implements step 3 of [event-sourced turn switching](2026-08-14-event-sourced-turn-switching.md).

P0 also emits an error catalog covering code, message stability, retryability, cancellation identity, and whether the error crosses a public protocol. TypeScript stack traces and Node-specific syscall wording are not compatibility promises unless an existing user-visible snapshot pins them.

P0 exits only when the Cargo workspace builds, every generated artifact is freshness-gated, both languages pass the same positive and negative fixtures, every shipped `!!js` use has a composition v1 representation, and no `web`, `headless`, ACP, or SDK profile changes behavior.

### P1: bidirectional migration bridge

P1 introduces `dsh-bridge-protocol`, a Rust bridge runtime, and a TypeScript Cordis facade. The bridge is symmetric: with Node as process root, the facade invokes a Rust sidecar; after process inversion, the Rust runtime can use the same protocol to host a time-boxed JS guest. The public SDK, ACP, and Host protocols never tunnel through or expose bridge frames.

#### Transport and handshake

The initial carrier is a child process's stdin and stdout using `Content-Length`-framed JSON, matching the repository's proven LSP framing model. Stderr is diagnostics-only and never carries protocol frames. Byte chunks use base64 in P1 because the bridge is temporary and correctness is the first constraint; a measured throughput or allocation failure may justify a binary payload extension without changing the logical messages.

Each side starts with `hello { bridgeVersion, role, build, schemaDigest, capabilities }` and refuses an unsupported version, role, or schema digest before registering services. Every frame carries a connection generation and request, resource, stream, or continuation id. Reconnection never reuses ids from a dead generation, so a late frame cannot complete new work.

#### Logical messages

| Operation | Required behavior |
|---|---|
| `call` / `reply` | Full-duplex, re-entrant request/response with exact service, method, arguments, result, and typed error |
| `cancel` | Idempotently aborts the owned request and all child resources; a completed request wins only when its terminal frame was sent first |
| `resource/open` / `resource/release` | Transfers an opaque handle while ownership stays with the creating process; disconnect releases every live handle |
| `stream/open` / `stream/chunk` / `stream/end` | Preserves per-stream order, terminal error or success, bounded buffering, receiver credit, and cancellation |
| `contribution/register` / `contribution/remove` | Registers services and event listeners under one plugin generation and removes them as one reversible effect |
| `event/invoke` | Carries serial, parallel, emit, or waterfall dispatch with the original event payload and scoped registration identity |
| `continuation/call` / `continuation/reply` | Implements one-shot waterfall `next()` so guest middleware can run code both before and after downstream listeners |
| `dispose` / `quiescent` | Stops new work, cancels or drains owned work according to the service contract, releases resources, and acknowledges only after complete quiescence |

The connection must continue reading frames while a callback or waterfall continuation is outstanding; a single request-at-a-time reader would deadlock on nested `next()` or service callbacks. Continuations are one-shot, generation-scoped resources. Returning without invoking the continuation short-circuits the waterfall exactly as Cordis does.

Every bridged field is classified as a JSON value, an owner-bound resource handle, a cancellation signal, or a continuation. A mutable waterfall request is value-threaded through `continuation/call` and returned with the downstream result, preserving before/after middleware behavior without pretending that two processes share an object reference. Live `Agent`, process, terminal, iterator, and callback objects cross only as handles. A parallel event that relies on shared mutable object identity is not bridgeable until it gains an explicit reducer or its listeners move into the same process.

Typed errors contain a stable code, public message when one exists, retryability, cancellation marker, and structured data. A remote stack is diagnostic metadata and never replaces the local error identity. EOF, malformed framing, protocol mismatch, or child death rejects every pending operation, terminates owned descendants, and makes the providing service unavailable; the facade never silently falls back to a different implementation mid-call.

Flow control is explicit. A stream sender may not exceed receiver credit, frame queues have fixed safety limits, and cancellation frames bypass ordinary data credit. The bridge conformance suite includes a stalled reader, cancellation during backpressure, nested callback, duplicate terminal frame, late old-generation frame, malformed frame, and process death with a live PTY.

#### Cordis and Rust ownership

Under the Node root, each TypeScript facade is an ordinary Cordis plugin: it declares injections, spawns or acquires the Rust sidecar inside `ctx.effect()`, registers the existing `ctx` key, converts `AbortSignal` to bridge cancellation, and awaits bridge quiescence during disposal. Consumers continue importing the Service Definition package and cannot tell which language implements the provider.

Under the later Rust root, the composer mounts first-party crates directly. A JS guest may contribute only through declared bridge services and event registrations; it cannot mutate the Rust registry through a hidden Node API. Plugin generation owns every registration, resource, callback, subprocess, and stream so unloading one guest generation removes all of them before the next generation can become ready.

The migration bridge is not the eventual third-party ABI. Before process inversion, a separate decision must choose either a closed first-party product or a stable process/WASM plugin format with explicit service, event, Host endpoint, permission, and version manifests. Rust `dylib` is not a stable public ABI.

The full bridge is also not the permanent worker protocol by default. P3 may reuse its framing and the `call`, `cancel`, `stream`, `resource`, and `dispose` semantics to prove an execution worker, but before P7 a separate versioned manifest must freeze the smallest internal IPC subset that resident and task workers actually need. Guest contribution and distributed waterfall messages remain migration-only unless a measured worker use case requires them.

#### P1 implementation order

1. Implement framing, handshake, symmetric calls, typed errors, cancellation, resource ownership, flow control, and fault-injection fixtures in Rust and TypeScript.
2. Prove `fs.resolve` plus text read across the bridge, including alias identity, missing targets, cancellation, and atomic mutation in an isolated directory.
3. Prove collect-mode and piped subprocess output, cancellation, process-tree termination, spill reporting, and process death.
4. Prove PTY allocation, input and output ordering, resize, signals, foreground process handling, cancellation, and whole-session quiescence.
5. Prove one synthetic Cordis service callback and one waterfall listener that calls `next()`, wraps its result, short-circuits, unloads, and rejects a late continuation.
6. Run the same fixtures with Node and Rust exchanging root and guest roles; no shipped profile uses the bridge by default yet.

P1 exits only when all six steps pass on supported macOS, Linux, and Windows process semantics, disposal leaves no child process or open handle, protocol faults fail loudly, and the root-role reversal changes no fixture. Execution-world providers switch in P3, not during bridge construction.

### Native operational model

The TypeScript tree already implements step 1 and step 2 of the event-sourced switching proposal: phase-aware drain writes `turn/pending`, pending-tail repair does not synthesize `interrupted`, and the shutdown path flushes live sessions before teardown. It does not implement step 3 automatic continuation or chunk deduplication. The vendored Include guard also rejects hot application of changed core-seam config and writes `$DSH_HOME/restart-request`; the repository contains the request producer and tests, but no assembled supervisor consumer, so registered restart is only a validated transition signal today.

| Existing or proposed mechanism | Rust phase | Native form and required evidence |
|---|---|---|
| TypeScript switching steps 1 and 2 | P0 fixtures, enforced at P5 | Preserve `turn/pending`, pending repair, `TOOL_OUTCOME_UNKNOWN`, and the shutdown flush fence as behavior-oracle fixtures; Rust must replay the same durable rows and terminal states |
| Step 3 automatic continuation and chunk deduplication | P5 | Make continuation part of the first Rust spine: append under a durable continuation cursor, reject or coalesce duplicate chunks idempotently, rebuild model-visible history, and wake the pending turn without replaying completed tool side effects |
| Execution-plane workers | P3, P5, then P7 | A resident execution-world worker owns constrained filesystem, subprocess, sandbox, PTY resources, and its process tree; a task worker is allowed for cheap isolated work; placement does not change the service API |
| Single writer and session ownership | P2 and P5 | Persistence uses an exclusive session lease; after the agent moves, its worker owns append order, flush, resume cursor, and release. Supervisor and web host never append to the same live session |
| Phase-aware drain and stuck tools | P5 | Reproduce the existing phase table natively. Model wait becomes pending immediately; a tool gets a configured bounded completion deadline, then records an unknown outcome and releases ownership. A three-to-five-second target is a candidate to measure, not a protocol constant |
| Registered restart | P7 and P8 | A supervisor state machine accepts a restart request, stops admission, drains or cancels by phase, flushes owners, waits for quiescence, starts the next generation, and publishes readiness. This replaces core-seam HMR rather than reproducing it |
| Blue-green or prewarmed host replacement | Not a default phase | Do not add a second host generation unless cold-start, configuration-load, session-reconstruction, and readiness measurements miss a stated availability target. Worker ownership should already keep live turns outside a web-host restart |

TypeScript step 3 is not a prerequisite for Rust P5. If P5 can arrive before users need crash-continuation in the current host, implementing the full resume and deduplication path twice is rejected. If the Rust schedule is too long for that product requirement, the bounded TypeScript fallback is to finish the registered-restart consumer and its operational tests; any later change to drain or repair semantics must update the P0 oracle in the same change.

### Replacement phases after P1

Phases are sequential at their exit boundaries. Work inside a phase may proceed in parallel, but a product profile does not switch until the whole phase exit is green.

| Phase | Owns | Exit |
|---|---|---|
| P0 protocol and schema foundation | Cargo workspace, generated contracts, composition v1, compatibility classes | Freshness and bidirectional conformance checks pass; profiles are unchanged |
| P1 bidirectional migration bridge | Framed IPC, lifecycle, streams, resources, callbacks, event contributions, fault handling | Filesystem, subprocess, PTY, waterfall, and reversed-role fixtures pass; profiles are unchanged |
| P2 leaf and persistence primitives | Branded values, settings, credentials, attachment, spill, JSONL and SQLite primitives, session leases | TypeScript coordinators use Rust implementations behind facades with behavior parity; a second writer cannot acquire one live session |
| P3 execution world | `fs`, `subprocess`, and `sandbox` providers, resident execution worker | Shipped `web` and `headless` profiles use one constrained Rust execution world with owned process-tree teardown; bash, PTY, and LSP Consumers are unchanged |
| P4 external streaming providers | DeepSeek and later LLM adapters, web fetch/search, MCP | Chunk order, retry, cancellation, error mapping, and teardown match provider fixtures |
| P5 model-visible spine | Session runtime and projection, scope, system-prompt, tools, agent registry, agent-loop, agent-worker ownership | Named headless and tool snapshots match; automatic pending-turn continuation, chunk idempotency, single-writer ownership, cancel, phase-aware drain, failure, unload, and empty-turn behavior pass |
| P6 product plugins | Approval, commands, user questions, compaction, jobs, skill, workflow, goal, plan, todo, subagent | Base and headless runtime closures contain no Node implementation required by their configured rows |
| P7 process-root inversion | Rust headless, SDK JSON-RPC, ACP entries, supervisor, minimal internal worker IPC; optional time-boxed JS guest | The three entries run from `dsh-runtime`; SDK and ACP assembled tests pass; restart never creates two session writers |
| P8 web host | Generated Host dispatch, HTTP uplink, WebSocket downlinks, static frontend, registered restart readiness | Existing React client and browser e2e run against the Rust host; a requested restart drains owners and returns ready without changing session semantics |
| P9 remove Node from the product | Remove JS guest and Node release closure; retain TypeScript development tools | Release artifacts and assembled product tests invoke only the Rust host |

### Plugin and module model

First-party plugins become Rust crates compiled into the binary and remain rows in declarative composition. The Rust runtime implements service registration, injection readiness, reversible effects, and emit, serial, parallel, and waterfall dispatch as explicit traits; it does not clone TypeScript declaration merging or HMR.

Tree-external extensibility is a product decision that must finish before P7. A stable process or WASM format may preserve replaceable rows without shipping Node; a closed product must explicitly withdraw that promise. The temporary JS guest cannot be the only extension mechanism at P9.

The replacement is also an opportunity to remove TypeScript-host mechanisms from the architecture rather than merely translate them. The following mechanisms are independent of Rust syntax and define how modules remain replaceable.

| Mechanism | Required design | Placement |
|---|---|---|
| Capability manifest | Each module declares provided and required services, event codecs and listeners, Host endpoints, permissions, resources, placement options, version range, and shutdown policy | Required foundation in P0/P1; generated for first-party crates and explicit for process/WASM plugins |
| Lifecycle ownership graph | One plugin generation owns every registration, stream, continuation, process, timer, and resource handle; unload closes admission and releases the owned graph in deterministic order | Required in P1 and the Rust runtime kernel |
| Worker placement policy | A module may be `in_process`, `resident_worker`, or `task_worker`; the composer validates whether its service values are serializable and whether its ownership requirements allow that placement | Design in P3, enforce through P7; no per-profile API forks |
| Declarative composition | Bundle and profile rows remain ordered data with schema-checked tagged runtime values; no arbitrary code executes while loading configuration | Required in P0 and used by every phase |
| Generated dispatch | Typert and TypeScript declarations generate endpoint, event, and schema manifests; Rust compiles static dispatch tables and does not perform runtime reflection | Required for P0 and P8 |
| Open event plugins | Durable event types register a codec, compatibility class, projection folders, and model-visibility metadata. Parallel listeners that need shared mutable identity become explicit reducers or stay co-located | Required for session work in P2/P5 |
| Supervisor policy | Modules declare admission close, drain, cancel, snapshot or flush, restart dependencies, and readiness. Restart requests are state transitions, not HMR callbacks | Design by P5, activate in P7/P8 |
| Runtime invariants | Registered diagnostics check single-writer ownership, leaked resources, stale generations, and quiescence without adding conditionals to `agent-loop` | Add with the owning phase; expose through the existing diagnostics capability |
| External plugin ABI | Prefer a versioned process or WASM manifest over Rust `dylib`; negotiate capabilities and permissions before registration | Decide before P7 only if tree-external plugins remain a product requirement |

Capability manifests, lifecycle ownership, declarative composition, generated dispatch, and the migration ledger below are required foundations. Worker placement and supervisor policy need explicit phase decisions and failure fixtures before activation. A public process/WASM ecosystem is deferred until the product chooses external extensibility; designing a marketplace or a broad stable ABI now would add obligations that the host replacement does not need.

### Rust crate topology and migration ledger

The target is a small runtime kernel plus capability families, not 219 one-for-one crate translations. `dsh-runtime` owns composition, registry, event dispatch, lifecycle generations, and entrypoints; `dsh-contracts` owns generated protocol views; `dsh-session` owns the open event envelope, codecs, projections, leases, and resume cursors; `dsh-execution` owns filesystem, subprocess, sandbox, terminal resources, and worker placement; `dsh-agent` owns scope, prompt, tools, registry, and loop; `dsh-providers` groups external LLM, web, and MCP adapters without merging their independent configuration; `dsh-host` owns SDK, ACP, Host dispatch, HTTP, WebSocket, and static serving; `dsh-supervisor` owns process generations and registered restart. Product plugins remain separate crates when they evolve independently, while `dsh-bridge-protocol` stays a removable migration dependency.

`native/dsh/migration/package-map.json` becomes the machine-readable migration ledger and `docs/rust-migration-matrix.md` its generated human view. The generator inventories every DSH `package.json`, internal peer-dependency edge, capability role, shipped composition row, and bundle patch; maintainers add the target crate or retained TypeScript disposition, phase, status, conformance fixtures, runtime placement, and `removeAfter` gate. CI rejects an unknown package or a migrated row whose dependency closure still selects an unrecorded Node implementation. This provides the requested package and reference checklist without making a manually maintained document the source of truth.

### Inventory

Replace the implementation and keep the Service Definition: `fs` / `fs-local` / `fs-sandbox`, `subprocess` / `subprocess-local`, `sandbox` / `sandbox-local` / `sandbox-windows-acl`, session persistence JSONL and SQLite, `session-query-sqlite`, `llm-deepseek` and later adapters, web fetch/search, `attachment-local`, `spill-local`, `settings-file`, and `credentials-local`.

Reimplement with identical semantics: `session`, `system-prompt`, `tools`, `agent`, `agent-loop`, `scope`, `approval`, `commands`, `user-questions`, `subagent` and in-process providers, `compaction`, `jobs`, `skill`, `host-apiproxy`, `webserver`, and `frontend-static`.

Do not port: HMR, Typert runtime reflection, arbitrary `!!js`, `tsx` source launch, or the Node `workflow-worker-thread` engine. Replace the workflow engine with a native or separate-process implementation when its configured row moves.

Keep on the TypeScript side: `apps/web` and `packages/client`, the Python and TypeScript SDK clients, the documentation website, and snapshot recorders that speak the public protocols.

## Alternatives considered

**Rewrite Cordis, the loop, and the web client in one effort.** Rejected: the plugin tree, session reconstruction, and snapshot corpus define product behavior. A green-field Rust harness would create a different product before compatibility could be measured.

**Translate npm packages to crates in directory order.** Rejected: package boundaries do not contain lifecycle behavior. `fs` without `subprocess` breaks execution-world identity, and `agent-loop` without session projection and event middleware breaks model-visible reconstruction.

**Create provider-specific CLI protocols.** Rejected: each ad hoc process wrapper would need its own cancellation, stream, error, ownership, and teardown rules, then become unusable after process-root inversion. One symmetric bridge gives those rules one implementation and one fault suite.

**Use unary JSON-RPC only and defer event semantics.** Rejected: subprocess and PTY expose live resources, and product plugins contribute callbacks and waterfall listeners. A unary bridge could move leaf methods but could not host the temporary guest required by process inversion.

**Delay process inversion until every plugin is Rust.** Viable but rejected as the primary plan: it withholds Rust entrypoint and SDK evidence until the end and makes the final switch too broad. P7 may still omit the JS guest if P6 finishes every configured row first.

**Embed a JavaScript engine permanently so TypeScript plugins keep loading.** Rejected as the completion condition: a permanent guest is a dual runtime. A time-boxed guest is allowed only through P8.

**Clone Cordis declaration merging, HMR, and Typert reflection in Rust.** Rejected: those are TypeScript-host mechanisms. Rust keeps the observable service, lifecycle, event, and Host endpoint semantics through explicit traits and generated manifests.

**Finish the complete TypeScript step 3 before starting the Rust spine.** Rejected as the default sequence: steps 1 and 2 already provide the durable behavior oracle, while implementing continuation cursors and chunk idempotency in both hosts doubles the highest-risk work. Reconsider only if an evidenced current-host requirement arrives before P5.

**Make blue-green restart part of the initial Rust architecture.** Rejected without measurements: worker ownership and a native supervisor should isolate turns from host replacement first. Add overlapping host generations only when an availability target and cold-start benchmark prove they are still necessary.

**Run every plugin in its own process.** Rejected: isolation, serialization, scheduling, and teardown cost differ by capability. Placement is declared per module, while in-process first-party crates remain the default for pure or latency-sensitive work.

**Treat containers or microVMs as `ctx.sandbox` providers.** Rejected by the existing sandbox decision: those replace the `fs` and `subprocess` execution world, not the same-world confinement runner.

**Rewrite the React client in Rust.** Rejected: the browser is already a separate process behind Host RPC. Replacing it is unrelated to removing Node from the product runtime.

## Acceptance criteria

- P0: generated schemas, manifests, positive and negative fixtures, the error catalog, composition v1 inventory, TypeScript step 1/2 turn-switching oracle, and phase-scoped P5 continuation scenarios are freshness-gated; currently owned cases pass bidirectional conformance; profiles do not change.
- P1: symmetric bridge calls, streams, resources, cancellation, callbacks, waterfall continuation, disposal, backpressure, fault injection, and reversed roles pass; filesystem, subprocess, and PTY prototypes leave no process or handle behind; profiles do not change.
- P2-P4: leaf, persistence, execution-world, and external provider facades default to Rust only after focused conformance and assembled snapshots pass; session leases reject a second writer; the constrained worker proves process-tree teardown; shadow comparison never double-writes production state.
- P5-P6: the model-visible spine and product plugins produce compatible session logs and assembled output; a pending turn resumes automatically under a durable cursor, duplicate chunks do not change reconstructed output, completed tools are not replayed, stuck-tool handling is bounded, and cancel, drain, failure, and unload semantics match.
- P7-P8: headless, ACP, SDK, and web entries run as `dsh-runtime`; the minimal worker IPC and supervisor prevent overlapping session owners; registered restart reaches quiescence and readiness; existing SDK, ACP, Host, and browser suites pass without client rewrites.
- P9: product documentation and release artifacts have no Node runtime dependency; the JS guest is absent; snapshot and assembled e2e jobs invoke only the Rust host; the supported tree-external plugin position is explicit.
- Migration inventory: the generated package matrix covers every DSH package and internal dependency edge, and every migrated composition row names its target, fixtures, placement, phase, and Node-removal gate.

## Risks

- **Two semantic owners.** Hand-maintained Rust and TypeScript schemas would drift. P0 permits one owner and generated derivatives only; a freshness failure blocks migration.
- **Distributed waterfall deadlock.** Nested callbacks and `next()` require re-entrant frame processing and one-shot continuation ownership. P1 fault tests pin both behavior and failure.
- **Unbounded bridge memory.** Fast producers can outrun a guest or facade. Receiver credit, bounded queues, cancellation priority, and process-death cleanup are protocol requirements rather than provider conventions.
- **Shadow side effects.** Comparing two implementations can duplicate writes or subprocesses. Stateful comparisons use isolated directories, disposable databases, or recorded inputs; production state is never dual-written.
- **Snapshot lock-in of TypeScript accidents.** Fixtures may encode Node-specific timing or wording. Only public text and specified order remain compatibility requirements; volatile fields follow existing normalization policy.
- **Turn-switching semantic drift.** TypeScript already owns `turn/pending`, pending repair, and the shutdown flush fence. Any later drain or repair change must update the P0 fixtures and phase-scoped P5 cases in the same change; prose is not a second semantic owner.
- **Session split brain.** A supervisor or second worker could append after ownership moved. Session leases are generation-scoped, append verifies the active owner, and takeover requires prior-owner death or a completed release before resume.
- **Bridge ossification.** Reusing the full migration bridge for internal workers would preserve guest-only contribution and waterfall complexity. P7 freezes a smaller worker protocol and keeps the bridge removable.
- **Unverified restart assumptions.** Rust startup and restart-window improvements have no repository benchmark yet, and the TypeScript tree contains a restart-request producer without an assembled consumer. Cold start, configuration load, session reconstruction, drain, and readiness must be measured before removing a fallback or adding blue-green complexity.
- **Open session event coverage.** The registered codec and folder model must include existing `turn/pending` rows and preserve their canonical bytes. Treating the event as unknown or ignorable would silently convert a resumable turn into incompatible state.
- **The JS guest becomes permanent.** P9 forbids shipping it. P7 cannot begin until the extension decision and the guest removal conditions are explicit.
- **Plugin authors lose TypeScript `apply(ctx)`.** Completion cannot retain that API without Node. A process/WASM format may preserve replaceable composition rows, but source-compatible TypeScript plugins are intentionally not promised.
- **Native launcher scope remains ambiguous.** Product-runtime removal of Node does not by itself rewrite the existing C11 Landlock executable. A literal all-Rust native-code goal must migrate it or record it as an audited exception.
