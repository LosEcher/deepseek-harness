# Agent Note: Agent worker process isolation

Status: proposed

English | [中文](2026-08-15-agent-worker-process-isolation.zh.md)

## Problem

The live `Agent` interface is a same-process object graph rather than a process-safe control API. It exposes a mutable `Session`, `Inbox`, and agent-scoped Cordis `Context`; `Session.append()` commits synchronously and notifies same-process observers before returning. Host API, compaction, goal, preset, subagent, and other product plugins read or mutate those objects directly. Replacing `AgentRegistry.setFactory()` with an RPC proxy would therefore preserve the type while breaking its timing, object-identity, and registration requirements.

The CLI process also composes the plugin tree and directly drains the agent loop during shutdown. A failure or uncooperative task inside one Agent can therefore retain the same process that owns unrelated Agents, Host API, and composition lifecycle. A Rust execution sidecar isolates selected filesystem or subprocess work, but it does not isolate the Agent loop, session writer, or agent-scoped plugins from the main process.

Rust migration has a separate replacement requirement: each Rust implementation must remain selectable beside the TypeScript implementation and pass the same conformance cases. Moving `agent-loop` to Rust before a process-safe Agent protocol exists would combine language migration, lifecycle redesign, and plugin relocation in one step.

## Proposal

Introduce a process-safe Agent control capability and first implement it with a Node worker process. Node remains the Cordis composer and main process. Each isolated Agent runs a complete TypeScript Agent composition in its own child process, including its live `Agent`, session, inbox, agent-scoped Cordis context, loop, and every plugin that requires those same-process objects. The main process owns supervision, routing, externally visible status, and read models; it never holds a remote object that claims to implement the current `Agent` interface.

The existing local TypeScript runtime remains an implementation of the same control capability. Profiles and presets select `local-ts` or `worker-ts` when an Agent generation is created. Rust providers remain ordinary capability providers inside either composition as described by [Rust capability providers behind Cordis](2026-08-15-rust-host-replacement.md); a Rust sidecar is not counted as Agent isolation.

### Process ownership

The worker process is the sole live-session writer for its Agent generation. It owns the session lease, synchronous append semantics, inbox mutation, scoped effects, model loop, tool dispatch, persistence flush, and orderly disposal. Plugins that read `agent.session`, `agent.inbox`, or `agent.ctx` mount inside that worker instead of calling through RPC.

The main process owns an `AgentDescriptor`, the worker generation, routing from Host/ACP/headless/subagent entrypoints, restart policy, and a bounded projection of status and session events. Main-process consumers request operations through the Agent control capability. Operations that currently accept a callback or mutable object, including `runMaintenance()` and direct Host-side session mutation, must move behind named worker commands or remain worker-local; functions and Cordis contexts never cross the process boundary.

Ownership identities converge on one monotonic epoch: the bridge connection generation, the worker generation, and the session lease owner are the same identity seen from three angles. A retired epoch rejects every late frame, command, and append. The session lease itself has two candidates for P0 to decide between: the external lease file prototyped in `dsh-session-store`, or session-event-stream ownership events that replay with the session. Stream ownership is the event-sourced option: the last ownership event names the current writer, rollback leaves no orphan lease, and crash recovery is just replay age. The external file stays only if P0 records why the event form cannot express the needed lease.

One child process initially owns one Agent. This gives a worker crash a single-session failure domain and makes process termination a valid last-resort cancellation mechanism. A later pooled-worker design requires separate evidence because it would allow one Agent failure to affect other Agents in the pool.

### Worker protocol

The first protocol version defines commands for `create`, `resume`, `send`, `followup`, `steer`, `inject`, `cancel`, `drain`, `dispose`, and read-model queries. Worker notifications cover `ready`, `status`, committed `session-event`, `drained`, and `fault`. Every frame carries a protocol version, Agent id, worker generation, request id where applicable, and a typed terminal result or error.

The main process rejects frames from retired generations. Command delivery is ordered per Agent, cancellation is idempotent, queues and event replay are bounded by receiver credit, and a disconnected worker cannot retain a live session lease indefinitely. `drained` means the Agent is quiescent, required session events are flushed, and the lease is ready to release; it is stronger than an idle status notification.

The worker protocol is not a second IPC. Commands are `call` frames on the product bridge with service `agent` and method names like `send` or `steer`; session-event notifications are `event/invoke` payloads; `cancel` and `drain` reuse bridge cancellation and the `dispose`/`quiescent` lifecycle. One set of framing, credit, cancellation, and generation primitives therefore serves both Rust providers and Agent workers.

Crash recovery starts a new generation and resumes from the durable session after the old lease is released or proven stale. The worker protocol does not transfer JavaScript heap state. Open-turn recovery and duplicate chunk handling follow [event-sourced turn switching](2026-08-14-event-sourced-turn-switching.md); until that proposal is implemented, a mid-turn crash remains observable as the current repair behavior.

### Backend switching

`local-ts` and `worker-ts` use the same Agent control conformance suite and produce the same public session events, snapshots, error identities, cancellation outcomes, and drain results. Backend selection is resolved explicitly from profile or preset configuration when a generation starts and is reported in diagnostics; it is not a hidden fallback.

Switching an existing Agent is a drain-and-resume operation, not live heap migration. At an idle checkpoint, the current backend drains and flushes, releases the session lease, and the selected backend resumes the same session as a new generation. During an active turn, the switch waits for drain or uses the pending-turn behavior only after event-sourced turn switching supplies that behavior. Failure to start the target backend leaves the durable session untouched and reports the failure; automatic fallback is allowed only when explicitly configured and recorded.

### Prioritized work queue

| Priority | Work | Exit condition |
|---|---|---|
| P0 | Define the Agent control Service Definition, worker wire schema, ownership table, generation rules, backpressure, session lease rules, and local TypeScript adapter | The protocol has positive and negative fixtures; every current direct `Agent` consumer is classified as worker-local, command-driven, or read-model-driven |

P0's protocol definition, ownership table, generation rules, backpressure, lease rules, wire schema, fixtures, and consumer classification live in the [Agent control protocol (P0)](2026-08-15-agent-control-protocol-p0.md) note.
| P1 | Build the Node worker supervisor and TypeScript worker implementation; add explicit `local-ts` and `worker-ts` profile/preset selection | Both backends pass the same keyless Agent lifecycle and assembled snapshot cases; killing one worker leaves the main process and other Agents usable; drain-and-resume preserves one session writer. The [P1 implementation](../../implemented/architecture/2026-08-15-agent-control-p1.md) ships the Service Definition and both backends; shipped profiles still use in-process `ctx.agents`, and assembled snapshots stay on that path until the worker mounts the product composition. |
| P2 | Replace the isolated execution-world providers with Rust implementations for filesystem, subprocess, sandbox, and PTY while retaining the TypeScript providers | Rust and TypeScript providers pass one capability conformance suite; a profile can select either provider; cancellation, stream order, process-tree cleanup, and disposal match |
| P3 | Add Rust persistence primitives for atomic replacement, file locks, JSONL/SQLite operations, and session leases, then use them behind existing TypeScript coordinators where measured | Storage fixtures and crash cases match; a second writer is refused; settings, credentials, attachments, and spill stores can opt in independently and opt back to TypeScript |
| P4 | Evaluate LLM transport, web fetch/search, MCP, and LSP transport individually | A provider moves only with recorded latency, throughput, memory, crash-isolation, or packaging evidence and a provider-specific conformance suite |
| Deferred | Keep session semantics, agent-loop, tools, system-prompt, scope, Cordis composition, Host clients, and product plugins in TypeScript | Reconsider only after the worker protocol is stable and measurements show that the remaining Node implementation prevents a stated product requirement |

P0 and P1 are the prerequisite for claiming Agent isolation. P2 and P3 may prototype against the existing Rust bridge, but they do not change that claim or move ahead of the worker conformance proof. Deno is not an implementation or compatibility target.

## Alternatives considered

**Return a remote object typed as the current `Agent`.** Rejected because synchronous session publication, mutable inbox access, scoped Cordis registration, object identity, and callback-taking methods cannot retain their current behavior over RPC.

**Rewrite `agent-loop` in Rust first.** Rejected because it combines process isolation with a new semantic owner for the model-visible loop before the process protocol and conformance oracle exist. Rust execution and persistence providers can deliver isolation and resource-control benefits without moving the loop.

**Treat the Rust execution sidecar as the Agent worker.** Rejected because the current sidecar owns only selected provider calls. The live Agent, session writer, inbox, scoped plugins, and loop remain in the main Node process.

**Run multiple Agents in one worker from the first version.** Rejected because a process crash or forced termination would affect unrelated Agents and would not prove the requested fault isolation. Pooling can be reconsidered after measuring per-Agent process cost.

**Replace Node or use Deno as the process root.** Rejected for this proposal. Node continues to host Cordis composition and existing TypeScript plugins; Deno is outside the target matrix.

## Acceptance criteria

- A versioned Agent worker protocol and process-safe Agent control Service Definition exist; the current `Agent` interface remains explicitly worker-local.
- `local-ts` and `worker-ts` are explicit profile/preset choices and pass the same lifecycle, cancellation, drain, resume, error, session-event, and keyless snapshot conformance cases.
- Terminating one Agent worker cannot terminate the main process or another Agent; the supervisor reports the fault and can resume a new generation from durable state.
- Exactly one generation holds the session lease and appends events. Late frames and commands from a retired generation cannot mutate current state.
- Command and event queues are bounded, receiver backpressure is tested, and cancellation and fault notifications are not blocked behind ordinary event traffic.
- A backend switch drains, flushes, releases, and resumes. It never relies on heap transfer or silently changes backend after a failure.
- Each Rust provider remains independently selectable beside its TypeScript provider and cannot become a shipped default before its capability conformance and assembled snapshots pass.
- Documentation and diagnostics distinguish Agent isolation, Rust provider isolation, configured backend, effective backend, worker health, and recovery outcome.

## Risks

- **Plugin placement mistakes.** A main-process plugin that still reads `agent.session`, `agent.inbox`, or `agent.ctx` would recreate an implicit remote-object API. P0 must classify every direct consumer before P1 changes a profile.
- **Session split brain.** A crashed or partitioned worker may appear dead while retaining resources. Generation checks, an exclusive lease, stale-owner rules, and fail-closed resume are required together.
- **Event lag and memory growth.** Host read models can fall behind a busy worker. Receiver credit, bounded replay, durable sequence cursors, and resnapshot rules must be specified before stress testing.
- **Shutdown ambiguity.** Idle, drained, flushed, disposed, and process-exited are different states. The protocol must expose each transition needed by the supervisor and never infer durability from process exit alone.
- **Per-Agent process cost.** Startup time, resident memory, file descriptors, and sidecar count may limit density. Measurements may justify warm workers or pooling, but those designs must retain an explicit isolation level.
- **Configuration generation drift.** HMR can change main-process composition while a worker uses an older generation. Creation records the effective config digest; incompatible changes require drain-and-resume instead of partial mutation.
- **Duplicate semantic owners.** Rust providers and worker transport must consume generated schemas or fixtures from their TypeScript Service Definitions. Hand-maintained copies would make `local-ts`, `worker-ts`, and Rust behavior diverge.
