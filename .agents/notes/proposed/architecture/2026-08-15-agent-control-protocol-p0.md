# Agent Note: Agent control protocol (P0)

Status: proposed

English | [中文](2026-08-15-agent-control-protocol-p0.zh.md)

## Scope

P0 of [Agent worker process isolation](2026-08-15-agent-worker-process-isolation.md). This note defines the process-safe Agent control Service Definition, the worker wire schema, the ownership table, generation rules, backpressure, session lease rules, and the local TypeScript adapter, and classifies every direct `Agent` consumer.

## Protocol surface from the current code

The Service Definition is derived from the live interfaces, not invented:

### AgentRegistry control surface (`packages/core/agent/src/index.ts`)

| Operation | Current shape | Worker protocol role |
|---|---|---|
| `create(options)` | async → `AgentHandle` | `agent/create` command |
| `resume(options)` | async → `AgentHandle` | `agent/resume` command |
| `register(agent)` | sync → disposer | worker-internal (publication happens in the worker) |
| `enter(agent, owner)` | sync → disposer | worker-internal |
| `announce(agent)` | sync | worker-internal (emits `agent/created`) |
| `get(id)` | sync → `Agent \| undefined` | read-model query `agent/get` |
| `list()` | sync → `Agent[]` | read-model query `agent/list` |
| `isOwnedBy(id, owner)` | sync → boolean | read-model query (subagent parenting) |
| `roots()` | sync → `Agent[]` | read-model query |
| `setFactory(factory)` | sync → disposer | worker-internal (factory never crosses the boundary) |
| `withInitiator` / `withoutInitiator` | sync | worker-internal (initiator attribution is process-local) |

### Agent control surface (`packages/core/agent/src/runtime-types.ts`)

| Operation | Current shape | Worker protocol role |
|---|---|---|
| `cancel(cause, options?)` | sync void | `agent/cancel` command (idempotent) |
| `whenIdle()` | async → void | `agent/whenIdle` command (resolves on `drained`-strength quiescence) |
| `runMaintenance(task)` | async → T, callback | **cannot cross the boundary**; either worker-local or a named maintenance command per consumer |
| `send(message, target, wakeup)` | sync void | `agent/send` command |
| `followup(message)` | sync void | `agent/followup` command |
| `steer(message)` | sync void | `agent/steer` command |
| `inject(message)` | sync void | `agent/inject` command |
| `session` / `inbox` / `ctx` | live objects | never cross the boundary; only their event projections do |

### Session control surface (`packages/core/session/src/index.ts`)

| Operation | Current shape | Worker protocol role |
|---|---|---|
| `append(type, data, ...)` | sync → event, notifies observers synchronously | worker-internal (sole writer) |
| `flush` (via coordinator) | async | `session/flush` command; also part of `drain` |
| events / surface read | sync read | read-model projection via committed `session-event` notifications |

### Notifications (worker → main)

| Notification | Payload | Meaning |
|---|---|---|
| `ready` | protocol version, generation, config digest | worker booted and holds the lease |
| `status` | agent id, generation, `idle`/`running` | mirrored `agent/status` |
| `session-event` | agent id, generation, seq, committed event | durable append committed; bounded by receiver credit |
| `drained` | agent id, generation | quiescent + flushed + lease ready to release |
| `fault` | agent id, generation, typed error | worker-local failure, supervisor acts |

## Ownership table

| Artifact | Owner | Notes |
|---|---|---|
| Session log (JSONL rows) | worker (sole live writer) | lease-guarded; see lease rules |
| Session lease | worker while alive | epoch-scoped; see lease rules |
| Inbox | worker | mutations are worker-local; projections to main are event-derived |
| Agent-scoped Cordis context | worker | plugins that need `agent.ctx` mount inside the worker |
| `AgentDescriptor` | main | identity, backend (`local-ts`/`worker-ts`), config digest |
| Generation counter | main (issues), worker (echoes) | see generation rules |
| Routing (Host/ACP/headless/subagent entrypoints) | main | commands translated to `agent/*` calls |
| Restart policy | main | crash → new generation after lease release/proof of staleness |
| Status + session-event read model | main | bounded projection, receiver credit |

## Generation rules

1. The main process issues a monotonic generation per worker lifetime. A new worker start always carries a fresh generation.
2. Every command, notification, and frame carries the generation. The main process rejects frames from retired generations; the worker rejects commands carrying a retired generation.
3. A generation is retired when: the worker exits cleanly, the supervisor disposes it, or the supervisor proves the lease stale after a crash/partition.
4. The worker's own bridge connection generation (from `dsh-bridge-protocol`) is the same epoch identity; the worker protocol does not maintain a second counter.
5. Late frames from a retired generation can never mutate current state: commands are rejected at the main boundary, notifications are dropped at the main boundary, and appends are rejected at the lease boundary.

## Backpressure

1. Command queues are bounded per agent. A full queue rejects the command with a typed `busy` error instead of buffering without limit.
2. `session-event` replay to main-process read models is bounded by receiver credit: the worker pauses notification after an unacknowledged credit budget and resumes on `stream/credit`.
3. Cancellation and fault notifications have priority: they are not queued behind ordinary event traffic (reuse bridge cancellation priority).
4. Event replay from durable storage on resume is bounded to a configurable window plus resnapshot; read models may request a full resnapshot instead of unbounded replay.

## Session lease rules

P0 decides between two lease candidates (see the worker-process proposal's ownership section):

- **Candidate A — external lease file** (`dsh-session-store` prototype): `<sessionId>.lease` created with `create_new`, containing owner/pid/acquired-at. Simple, process-independent, but orphan-prone on crash without supervisor cleanup, and invisible to the TypeScript coordinator's in-process single-writer model.
- **Candidate B — event-stream ownership**: ownership is expressed as session events (or an ownership envelope field) replayed with the session. The last ownership event names the current writer; rollback leaves no orphan lease; crash recovery is replay age. Requires the TypeScript coordinator to treat ownership events as the single-writer invariant, which is a semantic change to `session-persistence`.

Current state of the two writers (verified in code):

- TypeScript `SessionPersistenceCoordinator` serializes all per-session operations through an **in-process per-session promise chain** (`coordinator.ts` `chains: Map<SessionId, Promise<unknown>>`); there is no disk lock. Single-writer holds only while one process hosts the coordinator.
- Rust `dsh-session-store` lease is a **disk `create_new` file** with owner/pid/acquired-at (`lease.rs`); a second acquirer gets `AlreadyHeld`, but no process owns staleness proof (no heartbeat, no pid liveness check yet).

This is exactly the gap that makes two-way switching asymmetric: a Rust worker's disk lease is invisible to the TypeScript coordinator, and the TypeScript promise chain is invisible to a second process. P0's lease decision therefore also decides the cross-process story: Candidate A needs a staleness proof (owner pid liveness or heartbeat) plus TS-side recognition of the lease file; Candidate B makes the session log itself the arbiter and removes the second mechanism entirely.

### P0 lease decision: candidate B (event-stream ownership)

P0 adopts **candidate B** for the worker protocol. Rationale, in P0's own terms:

1. **It removes a mechanism instead of adding one.** Candidate A layers a third single-writer mechanism (disk lease file) on top of the TypeScript promise chain, and still needs staleness proof plus TS-side recognition to be switch-safe. Candidate B makes the session log — the one artifact both sides already replay — the arbiter; rollback leaves no orphan, crash recovery is replay age.
2. **It is the event-sourced option.** DSH's session log is the durable source of truth and the extension surface. Ownership as an event (or envelope field) is a projection of that log, not a side channel that can drift from it.
3. **It converts the asymmetric-gap risk into an invariant.** The gap documented above disappears: the TypeScript coordinator gains an ownership event check instead of needing to discover an external file it never created.

Costs accepted: `session-persistence` coordinator must treat ownership events as the single-writer invariant (a semantic change, explicitly scoped to the worker protocol's session surface); the Rust `dsh-session-store` external lease file stays available as a leaf primitive (P3) for coordinators that do not adopt stream ownership, but it is not the worker-protocol lease.

Rules that hold under either candidate:

1. Exactly one generation holds the lease and appends events. A second acquirer is refused (`AlreadyHeld` under A; invariant violation under B).
2. A disconnected or crashed worker cannot retain the lease indefinitely: under A the supervisor must prove staleness (owner pid dead or heartbeat expired) before a new generation acquires; under B replay age decides.
3. `drained` is the only state after which the lease is released for a planned switch; process exit alone is never proof of durability.
4. Backend switching (local-ts ↔ worker-ts) is drain + flush + lease release + resume as a new generation, never heap transfer and never a hidden fallback.

## Wire schema (bridge mapping)

The worker protocol is a service face over `dsh-bridge-protocol`, not a second IPC. Each protocol role maps onto an existing bridge message type:

| Worker protocol role | Bridge message | Payload shape |
|---|---|---|
| `agent/create` / `agent/resume` | `Call` (service=`agent`) | `{ id?, options: CreateAgentOptions \| ResumeAgentOptions, owner }` |
| `agent/send` / `followup` / `steer` / `inject` | `Call` (service=`agent`) | `{ message: UserMessage, target?, wakeup? }` |
| `agent/cancel` | `Cancel` (id = agent command id) | — |
| `agent/whenIdle` | `Call` (service=`agent`) | — |
| `session/flush` | `Call` (service=`session`) | — |
| `agent/get` / `list` / `roots` / `isOwnedBy` | `Call` (service=`agent`, read-model queries) | query params |
| `ready` | `Hello` + first `ContributionRegister` (plugin=`agent-worker`) | `{ protocolVersion, generation, configDigest }` |
| `status` / `drained` / `fault` | `EventInvoke` (event=`agent/status` etc.) | typed payload |
| committed `session-event` | `EventInvoke` (event=`session/event`) | `{ seq, event }`, flow-controlled by `StreamCredit` |
| `drain` | `Dispose` (id = agent command id) | — |
| `drained` ack | `Quiescent` | — |

Functions and Cordis contexts never cross the boundary in any payload; `UserMessage` and event payloads are JSON-serializable values only. `runMaintenance` callbacks are the one operation with no wire form: each consumer that needs one becomes either worker-local or a named maintenance command defined by that consumer.

## Local TypeScript adapter

`local-ts` remains an implementation of the same Service Definition: the registry and Agent surface above ARE the local adapter. The worker protocol's commands map 1:1 onto the local operations; conformance is asserted by running the same positive/negative fixture corpus against both backends.

## Consumer classification

See the P0 classification table in [the appendix](#appendix-consumer-classification) (assembled from the per-package audit).

- **worker-local**: must move into the worker; the P1 worker composition must mount them.
- **command-driven**: can become `agent/*` calls from the main process; no live objects required.
- **read-model-driven**: main process maintains the projection; no Agent access at all.
- **type-only**: imports types only; unaffected.

Key audit findings:

- **No existing pure command-driven consumer.** Every current direct consumer either touches live objects (session/inbox/ctx), reads projections, or is type-only. The RPC command layer is new construction, not translation of existing code — the control-method call sites live inside worker-local files (agent-loop drives its own machine).
- **Session write surface is decisive.** Hooks bridges (`session.append` for hook/invoked+result), llm-retry, web-search, checkpoint-policy, api-proxy, and agent-loop all write session events; write access vetoes into worker-local.
- **Inbox mutation is rare and concentrated.** `agent.inbox.prepend/remove/replace` appears in agent-instructions and api-proxy only — the smallest, highest-value relocation target.
- **Boundary pieces needing a decision** are listed in the appendix (agent-lookup, core/tools scope routing, workflow host, tool-cordis/tool-terminal, web-search initiator, shutdownDrain, live-object WeakMap keys).

## Acceptance criteria

- The Service Definition table above matches the live interfaces; no operation needed by a classified consumer is missing a named command or worker-local home.
- Every direct `Agent` consumer in the repository is classified; the classification is reproducible (each row cites the file and the usage that decided it).
- The lease candidate decision is recorded with the reason (this note's lease rules section).
- Positive and negative fixtures exist for the wire schema (mirroring `native/dsh/contracts` style) and pass against both `local-ts` and `worker-ts`.

Fixtures live in `packages/core/agent/contracts/` (`agent-worker-manifest-source.json`, `agent-worker-manifest.json`, `agent-worker-positive.json`, `agent-worker-negative.json`), following the native contracts pattern: a manifest source, a digest-verified manifest, and positive/negative case lists whose frames are bridge messages. The manifest digest and freshness check are wired when the first adapter consumes them (local adapter in P0/P1).

### Decisions made by P0 vs. decisions deferred to review

P0 records the following as **made** (recorded in this note): the protocol surface tables, the bridge-mapping wire schema, the epoch-unified ownership table, generation rules, backpressure rules, the lease decision (candidate B), the local adapter shape, and the consumer classification with its 12 boundary items.

Human review confirmed the P0 recommendations: lease candidate B, and all twelve appendix boundary items. [P1](../../implemented/architecture/2026-08-15-agent-control-p1.md) implements the Service Definition, supervisor, and both backends.

## Risks

- **Classification mistakes**: a consumer marked command-driven that secretly mutates `agent.session` or `agent.inbox` would recreate an implicit remote-object API. Each command-driven row must cite the exact operations used.
- **runMaintenance callback consumers**: any consumer that passes a closure must either move worker-local or be redesigned to a named maintenance command before P1.
- **Lease candidate A orphan window**: supervisor staleness proof must be specified before stress testing; candidate B avoids the window but changes TypeScript coordinator semantics.
- **Event lag**: read models may fall behind a busy worker; receiver credit and resnapshot rules must be exercised in P1 stress tests.

## Appendix: consumer classification

Assembled from four read-only audit batches (core/context; product plugins; entrypoints/host/client; tools/terminal/skill/test-support). Each row cites the usage that decided the classification. `Agent` = `session`/`inbox`/`ctx` live objects + control methods (`cancel`/`whenIdle`/`runMaintenance`/`send`/`followup`/`steer`/`inject`).

### Batch A — core and context (31 files)

| 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|
| agent/src/index.ts (AgentRegistry) | `agent.id`, `agent.session.id`, `scopeTarget(agent, agent)`, `this.get(id)?.ctx`, `AsyncLocalStorage<Agent>` | 读（身份/ctx） | worker-local | 活体注册表：以 agent 对象为 store/scope 键、对外交出 `agent.ctx` |
| agent/src/dispatch.ts | `scopeTarget(agent, agent)` 注入 payload | 读（identity） | worker-local | agent 对象耦合为 scope 载体与事件 subject |
| agent/src/inbox.ts (Inbox) | `session.append('agent/inbox/spliced')`, next-turn/next-step 可变列表 | 写 | worker-local | `agent.inbox` 实现本体 |
| agent/src/model-selection.ts | `installModelSelection(agentCtx, …)` 挂 waterfall 监听 | 读（ctx 挂载） | worker-local | agent 作用域装配 |
| agent/src/consumed-work.ts | 纯函数折叠 `SessionEvent[]` | — | type-only | 无实例用法 |
| agent/src/types.ts | declare 事件词汇 | — | type-only | 纯类型 |
| agent/src/invariant.ts | `agent/status` 监听 + `WeakMap<Agent, AgentStatus>` | 读 | read-model-driven（边界） | 身份键可改 sessionId |
| agent-loop/src/agent.ts (ReactLoopAgent) | 实现 Agent 全部面：session.append、inbox.splice/claim、dispatch、全部控制方法 | 写 | worker-local | worker 的核心 driver |
| agent-loop/src/index.ts (AgentLoop) | `agent.ctx.sessions.enter/announce`, `loopCtx.agents.enter`, `machine.drainToIdle/cancel/whenIdle`, `setup?.(agent.ctx)` | 写 | worker-local | 工厂+生命周期所有者；`shutdownDrain`/`markProcessExiting` 是 CLI RPC 化候选 |
| agent-loop/src/runtime-context.ts | 读 `session.surface/events`, `ctx.on('session/event')` | 读 | worker-local | 回合内投影，subject identity 绑定 worker |
| agent-loop/src/invariant.ts | `ctx.sessions.get(sessionId)`, 读 events/deriveMessages | 读 | read-model-driven（边界） | 依赖 `ctx.sessions` 活体查询 |
| agent-default-model/src/{index,invariant}.ts | 纯配置服务 | — | type-only | 无 Agent 引用 |
| agent-tool-presentation/src/{index,invariant}.ts | `ctx.tools.presentAs()` | — | type-only | host 平面 |
| core/tools/src/index.ts | `chainLayers(exec.agent)`, `scopeTarget(this, exec.agent)` | 读（identity 路由） | worker-local（身份依赖，需定夺） | scope 链符号属性挂在 agent 对象上；注册表按设计留 host 平面 |
| context/agent-instructions/src/config.ts, digest.ts, files.ts, invariant.ts, render.ts | 纯工具/配置 | — | type-only | 无 Agent 引用 |
| context/agent-instructions/src/index.ts | 读 session surface/events/header；**写 inbox**（prepend/replace/remove）；`agent/pre-step` waterfall；WeakMap 活体键 | 写+读 | worker-local | 最重混合体：inbox 可变面 + pre-step 分发 |
| context/agent-instructions/src/state.ts | 只读 surface/events 派生 | 读 | read-model-driven | 由 worker-local index.ts 调用 |
| context/session-reference/src/index.ts | 读 header.cwd、agent.id；跨会话走 `ctx.sessionQuery` | 读 | read-model-driven | header 有主进程持久投影可替代 |
| context/time-context/src/index.ts | `agent/pre-step` 监听；读 session.events | 读 | worker-local | pre-step 扩展点必须在 worker 内 |
| context/tmux-context/src/index.ts | 同上 + `ctx.shell` | 读 | worker-local | 与 time-context 同构 |
| sandbox/sandbox-policy/src/index.ts | `context.agent?.session` → events/header/id | 读 | read-model-driven | agent 可为空（agentless 回退） |
| session/session-checkpoint-policy/src/index.ts | 三处 `ctx.sessions.flush(...)` | 写 | worker-local | driver 内 flush 栅栏 |
| session/session-telemetry/src/coordinator.ts | 读 events/header；`WeakMap<Session, number>` 游标 | 读 | read-model-driven | 键改 sessionId 即可 |
| llm/llm-retry/src/index.ts | `agent.session.append('llm/retry'/'llm/retry-started')` | 写 | worker-local | 请求恢复扩展点内写 session |
| web/web-search-deepseek/src/index.ts | `currentInitiator()?.session.append(...)` | 写 | worker-local（环境依赖，需定夺） | initiator ALS 要求同进程 |

Batch A summary: worker-local 14 / read-model-driven 6 / type-only 11 / command-driven 0.

### Batch B — product plugins (34 files)

| 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|
| subagent/src/index.ts | 仅 `parent: Agent` 类型透传 | 读（仅传引用） | type-only | Service 定义层 |
| subagent/src/child-agent.ts | `parent.ctx.get('agentPresets'/'sandboxPolicy'/'approval')`, `parent.session.header`, `parent.options` | 读 | worker-local | 从 parent 活体 ctx 读服务 + 读 session.header |
| subagent/src/continuation.ts | session.append（delegated 覆盖写）、header 读、`agent.ctx.on('agent/inbox/claimed'/'discarded')`、`agent.ctx.sessions.flush`、cancel/whenIdle/followup/steer/inject、status | 读写 | worker-local | 全套消费：写子会话 + 挂 ctx 监听 + flush + 四控制方法 |
| subagent/src/lifecycle.ts | `child.session.events` 只读派生 | 只读 | read-model-driven | 主进程投影可替代 |
| subagent/src/types.ts | 纯类型 | — | type-only | 无实例 |
| subagent/src/depth.ts | header.delegationDepth、options 读 | 只读 | read-model-driven | 纯函数 |
| subagent/src/activation-setup-registry.ts | 仅类型 + childCtx | — | type-only | 子作用域安装 |
| subagent-in-process-driver/src/index.ts | session.append('subagent/descriptor')、parent.ctx.agents.create、cancel/followup/whenIdle、session.events 读 | 读写 | worker-local | 直接 append + 建子 agent + 控制方法 |
| subagent-fork-in-process/src/index.ts | parent.session.events 只读 | 只读 | read-model-driven | 无写/无方法 |
| tool-subagent/src/index.ts | `exec.agent` 作 parent 凭据传给 subagents.start | 读（传引用） | type-only | 不透表面，凭据语义决定 subagent 服务 worker-local |
| tool-subagent-control/src/list-agents.ts | agent.status/id、ctx.agents.get | 只读 | read-model-driven | 投影可替代 |
| tool-subagent-report/src/index.ts | `exec.agent` 作凭据 | 读（传引用） | type-only | 不透表面 |
| goal/src/index.ts | session.append('goal/change')、events/seq 读、`WeakMap<Session, GoalCache>`、`agentEvents(...agent)` | 读写 | worker-local | append 会话 + Session 身份缓存；`@Remote` 网关已暴露控制面但实现就地写会话 |
| goal/src/domain.ts | 纯类型 | — | type-only | 无实例 |
| goal-round-driver/src/index.ts | inbox.prepend + nextStep/nextTurn 读、flush(agent.session)、followup/cancel/whenIdle、`Map<Agent, DriverState>`、`ctx.agents.get(id) === agent` | 读写 | worker-local（整体） | inbox 写 + 身份键控 + 控制方法，无法拆分 |
| tool-goal/src/authority.ts | session.events、status、id、agents.get/roots | 只读 | read-model-driven | 无写/无方法 |
| schedule/src/runtime.ts | session.append('schedule/change')、events/header 读、runMaintenance/followup/whenIdle、flush | 读写 | worker-local | 维护任务内写调度事件 |
| schedule/src/index.ts | `agent.ctx.effect(...)` + `agent.ctx.on('agent/status')`、events 读、`Map<Agent, OwnerCleanup>` | 读写 | worker-local | agent.ctx 挂 effect/监听 |
| schedule/src/tools.ts | session.append、events/header 读、flush、`exec.agent !== agent` 校验 | 读写 | worker-local | 工具直接 append |
| schedule/src/transaction.ts | 仅 `WeakMap<Agent, Promise>` 串行化键 | —（仅键） | type-only（键改 sessionId） | 弱进程内依赖 |
| compaction/src/index.ts | 仅定义结构子集 | — | type-only | 抽象 Service 定义 |
| compaction-basic/src/index.ts | session（surface 折叠/measure/prune）、options、runMaintenance、WeakMap 身份、多事件监听 | 读写 | worker-local | 自动压紧改写会话 surface |
| compaction-basic/src/region.ts | session.append（含 surfaceOp replace）、surface/events/requestHeader 读 | 读写 | worker-local | 压缩事务核心 |
| compaction-basic/src/summarizer.ts | requestHeader/options/id 读 | 只读 | read-model-driven（建议随 region 搬） | 需活体最新 header，避免投影双写 |
| jobs/src/index.ts, jobs/src/types.ts | 纯类型/抽象签名 | — | type-only | 无实例 |
| jobs/src/invariant.ts | owner?.id 读 | 只读 | read-model-driven | 投影可替代 |
| jobs-local/src/index.ts | `owner.ctx.effect(...)`、`scopeOf(owner.ctx)`、`Map<Agent>`/TrackedTask.owner、owner.id | 读写 | worker-local | 依赖活体 ctx 作用域链 |
| tool-jobs/src/index.ts | followup/inject、status、`WeakMap<Agent,number>`、agent/inbox/claimed 监听 | 控制方法为主 | command-driven | 可改 RPC 命令（键换 sessionId） |
| plan-mode/src/index.ts | session.append('plan/mode')、events 读、inject/steer、WeakMap<Session>、pre-step 监听 | 读写 | worker-local | append + inject/steer + 身份缓存 |
| interaction/commands/src/index.ts | session.append('command/run'/'done')、`layers.merge(agent,…)`、handler 收活体 agent | 读写 | worker-local | 写命令生命周期 + Agent 对象作用域键；`@Remote` 网关已暴露 execute |
| interaction/user-approval/src/index.ts | session.append('approval/asked'/'decided')、setApprovalPolicy、inject、scopeTarget | 读写 | worker-local | 写审批审计事件 |
| interaction/user-questions/src/index.ts | agent.id、agents.get 校验、roots().includes | 只读 | read-model-driven | 身份校验 |
| guard/repeat-tool-reminder/src/index.ts | `WeakMap<Agent, Chain>` 身份键、exec.agent | 只读（仅身份键） | worker-local（最弱形态，需定夺） | 键换 session-id 可降级为事件驱动留主进程 |

Batch B summary: worker-local 15 / command-driven 1 / read-model-driven 8 / type-only 10.

### Batch C — entrypoints, host, client (26 files)

| 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|
| acp/acp/src/index.ts | followup/whenIdle/cancel, `agents.get(id) !== agent` 校验 | 读+控制 | command-driven | ACP 桥只驱动自有 agent |
| api/remotes/src/index.ts | 纯 re-export | — | type-only | 无实例 |
| api/remotes/src/agent-lookup.ts | `ctx.agents.get/resume`, session.header 读, `configureHost('agent', … => agent.ctx)` | 读+工厂+ctx 移交 | worker-local（边界，需定夺） | 「session id → 活体 Agent/ctx」解析器，worker 化后必须改远程投影 |
| api/remotes/src/client/index.ts | 纯类型 | — | type-only（remote projection） | client 装配面 |
| host/apiproxy/src/index.ts | 只构造 createApiProxy | — | type-only（委托） | 语义随 api-proxy.ts |
| host/apiproxy/src/api-proxy.ts | session.append, inbox.replace/remove, inbox.nextTurn/nextStep 读, session.events 读, steer/followup/cancel, `WeakMap<Agent,…>` | 写+ctx+控制 | worker-local | session/inbox/ctx 三面全触的重度消费者 |
| bundle/headless/src/index.ts | installModelSelection(agentCtx), whenIdle, followup, flush | 读+ctx+控制 | worker-local | 已是 worker 原型 |
| sdk/server/src/server.ts | followup, session.id 读 | 读+控制 | command-driven | JSON-RPC 只 followup 驱动 |
| extensions/cordis-host-runner/src/index.ts | steer/inject, agent.id 比对 | 控制+读 | command-driven | 动态插件反馈 |
| extensions/cordis-host-runner/src/inspect-registry.ts | agent.id 读, 透传 live agent 给 provider 回调 | 读 | read-model-driven（需定夺） | 透传是同进程依赖 |
| extensions/tool-cordis/src/index.ts | `exec.agent` 转发 runner, agent/pre-step 读 | 控制+读 | command-driven（需定夺） | 工具执行世界归属未定 |
| extensions/tool-cordis/src/api-catalog.ts | 无 | — | type-only（数据） | 生成字符串字面量 |
| extensions/tool-cordis/src/inspect.ts | agent 作 snapshot scope 参数 | 读 | read-model-driven | 自省渲染 |
| client/runtime/steering-history.ts, ui-conversation/conversation-nodes/inbox.ts, ui-trajectory/trajectory-message-definitions.ts | 仅 import 类型 + 事件重放 | — | type-only（remote projection） | client 侧投影 |
| preset/agent-presets/src/index.ts | `composedPreset(agent.ctx)`, scope 链操作, agent/created 监听 | 读+写 scope 绑定 | worker-local | 预设组成系统挂 agent.ctx |
| preset/agent-presets/src/authoring.ts, discovery.ts, metadata.ts, session.ts | 纯 fs/纯函数 | — | type-only | 无 Agent |
| preset/agent-presets/src/invariant.ts | 只读 agent.id/agent.ctx 断言 | 读 | read-model-driven | invariant 伴生 |
| preset/agent-presets/src/mount.ts | `agentCtx.plugin(PresetTree, config)` | ctx 挂载 | worker-local | 组合核心 |
| examples/acp-demo/src/index.ts, agent-spine-demo/src/{index,invariant}.ts | 纯 ctx.plugin 编排 | — | type-only | 组合示例 |

Batch C summary: worker-local 5 / command-driven 4 / read-model-driven 3 / type-only 14.

### Batch D — tools, terminal, skill, workflow, hooks, test-support (22 files)

| # | 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|---|
| 1 | shell/tool-bash/src/index.ts | header.cwd 读, agent 作身份令牌传 sandboxPolicy/approval/jobs | 读 | read-model-driven | 只读 header 派生，令牌可改 agent.id |
| 2 | shell/tool-bash-persistent/src/index.ts | header.cwd 读, `owner.ctx.effect(...)`, `WeakMap<Agent,…>` | 读+ctx 挂载 | worker-local | agent.ctx 挂 effect + 身份键 |
| 3 | shell/tool-pwsh/src/index.ts | 与 tool-bash 同构 | 读 | read-model-driven | 镜像 |
| 4 | terminal/terminal/src/index.ts | `SessionRecord.owner: Agent`, Map/WeakSet 身份键, `owner.ctx.effect(...)`, `isLiveOwner` 对象同一性 | 写+ctx | worker-local | 硬依赖同进程 identity |
| 5 | terminal/terminal/src/types.ts | 纯类型 | — | type-only | 无实例 |
| 6 | terminal/terminal-bash/src/index.ts | `owner.ctx.on('internal/dispatch',…,{global:true})`, WeakMap, session 同一性 | 读+ctx | worker-local | 挂 ctx 监听 + 身份键 |
| 7 | terminal/tool-terminal/src/index.ts | 仅 requireAgent 后转发 `ctx.terminals.*` | 无 | command-driven（需定夺） | 落脚点取决于 terminals 服务去向 |
| 8 | skill/tool-skill/src/index.ts | header/surface/events 读, agent 作 scope 键 | 读 | read-model-driven | 只读投影 |
| 9 | workflow/workflow/src/runtime-types.ts | 纯类型, `WorkflowStartRequest.parent: Agent` | — | type-only | parent 字段是活对象引用 |
| 10 | workflow/workflow-worker-thread/src/host.ts | 转发 `parent: Agent` 给 subagents.start | 无 | command-driven（需定夺） | child-agent 读 parent.session/ctx，深度耦合 |
| 11 | hooks/hooks-claude-code/src/index.ts | `session.append`（hook/invoked+result）, inject/steer, Map 身份键 | 写+控制 | worker-local | 回合内 session 写面一票否决 |
| 12 | hooks/hooks-codex/src/index.ts | 同构 | 写+控制 | worker-local | 同上 |
| 13-14 | test-support/agent-loop-testkit/src/{index,invariant}.ts | 无 | — | type-only | 零接触 |
| 15 | test-support/loader-smoke/src/agent-turn.ts | whenIdle/followup, session 身份, flush | 控制+读 | command-driven | 测试编排可 RPC 化 |
| 16 | preset/agent-presets/src/（index/mount/invariant） | agent.ctx 重使用 | ctx 挂载 | worker-local | 与 Batch C 重叠 |
| 17 | context/agent-instructions/src/index.ts | inbox 写 + 读 | 写+读 | worker-local | 与 Batch A 重叠 |
| 18-22 | agent-instructions/state.ts, time-context, session-reference/{index,projection}, tmux-context | 只读 | 读 | read-model-driven | 与 Batch A 重叠 |

Batch D summary: worker-local 7 / command-driven 3 / read-model-driven 8 / type-only 4 (some rows overlap batches A/C).

### Consolidated counts

| 分类 | Batch A (core/context) | Batch B (product plugins) | Batch C (entry/host/client) | Batch D (tools/terminal/skill) |
|---|---|---|---|---|
| worker-local | 14 | 15 | 5 | 7（含与 A/C 重叠 2） |
| command-driven | 0 | 1 | 4 | 3 |
| read-model-driven | 6 | 8 | 3 | 8（含与 A 重叠 5） |
| type-only | 11 | 10 | 14 | 4 |
| **合计** | 31 | 34 | 26 | 22 |

Total files audited: 113 (some rows overlap between batches A and D). Distinct worker-local core set ≈ 33 after dedup; command-driven ≈ 7 (plus new RPC surface); read-model-driven ≈ 17; type-only ≈ 29.

### Items needing human decision

Each item carries the P0 recommendation; confirm or override per item.

1. **`api/remotes/agent-lookup.ts`** — 「session id → 活体 Agent/ctx」解析器；`configureHost` 把 live ctx 交给 Host RPC 层。worker 化后必须转型为远程投影工厂，或整体随 worker。**P0 建议：转型为远程投影工厂**——保留主进程的 command/read 部分（create/resume 经 `agent/*` 调用、header 走投影），`configureHost` 改为解析远程 handle，实现体随 worker。这是 P0 首攻点。
2. **`core/tools/src/index.ts`** — scope 路由依赖 agent 对象身份（`chainLayers`/`scopeTarget`），但注册表按设计留 host 平面。二选一：(a) scope 层按 sessionId 重键 + worker 内注册经 RPC 同步；(b) 每 worker 复制注册表。**P0 建议：(a) sessionId 重键**——保持注册表单副本，避免多 worker 复制漂移；scope 父链改用 sessionId→parentSessionId 映射，worker 内注册经 RPC 同步。
3. **`workflow-worker-thread/src/host.ts`** — 转发 `parent: Agent`，child-agent 读 parent.session/ctx。若子代理创建 worker-local，host 必须同进程；或 parent reify 为 id+RPC 代理。**P0 建议：parent reify 为 id + 远程代理**——child-agent 对 parent 的读取改为 worker 内投影（parent 的 session 事件经 bridge 重放），host 留主进程。
4. **`tool-cordis` `exec.agent` / `tool-terminal`** — 工具执行世界归属未定：工具执行面留主进程则 `exec.agent` 变远程 handle（requireAgent 契约全改）；随 worker 走则无碍。**P0 建议：工具执行世界随 worker**——工具依赖 agent.ctx/scope，留在主进程将强制大量命令化改造；随 worker 走保持 requireAgent 契约不变。
5. **`web-search-deepseek`** — `currentInitiator()` ALS 写 session；执行面留主进程则写静默丢失。**P0 建议：provider 随 worker 执行**（保持 initiator 写面），或写改 RPC（携带 sessionId）。
6. **`agent-loop/src/index.ts` shutdownDrain/markProcessExiting** — CLI 调用入口应改跨进程 RPC 命令，其余留 worker。**P0 建议：改 RPC 命令**（`agent/drain` 已有 wire 形态，复用）。
7. **只读消费者活体键改造** — session-telemetry、agent/src/invariant、agent-loop/src/invariant、terminal 系、schedule/transaction、tool-jobs、repeat-tool-reminder 均以 Agent/Session 对象为 WeakMap 键。**P0 建议：统一改 sessionId 键控 + 主进程事件投影**（低成本，P1 前完成）。
8. **agent-presets 自然切分** — index/mount（组合面，worker-local）与 authoring/discovery/metadata/session（纯 fs，type-only）可干净分开。**P0 建议：按此切分**，发现/作者面留主进程。
9. **goal 与 commands 的 `@Remote` 网关** — 控制面可命令化，但实现体（session.append + 身份缓存）必须 worker-local。**P0 建议：网关留主进程做 RPC 壳（复用现有 Typert Gateway 作为 P0 命令化通道起点），实现体随 worker。**
10. **repeat-tool-reminder 最弱形态** — 零表面访问，仅 `WeakMap<Agent, Chain>` 身份键。**P0 建议：键换 sessionId + 事件 RPC 订阅，降级留主进程。**
11. **compaction-basic/summarizer** — 只读但需活体最新 header。**P0 建议：随 region.ts 一并搬 worker**，避免投影双写。
12. **tool-subagent 凭据语义** — 活体句柄作所有权凭据；隔离后句柄变 id/proxy，权威校验（`handle.agent === child`）依赖同进程身份。**P0 建议：subagent 服务整体 worker-local**（凭据语义不可 RPC 化），tool-subagent 本身 type-only 不动。

Cross-cutting facts: hooks 双桥经 `appendHookInvoked/appendHookResult` 写 session（hook-protocol/src/events.ts:75-104）；child-agent.ts:107-108 读 parent.session.header/ctx；goal/commands 已有 Typert Gateway 暴露控制端点（SessionId→活体 Agent 解析），可作 P0 命令化通道起点；现有代码**无纯 command-driven 消费者**——RPC 层是新建而非平移；`scopeOf(ctx)` 读 `ctx[kScope]` 符号标签（core/scope/src/index.ts:154），`ScopedLayers.merge(agent,…)` 以 Agent 对象直接作作用域键走 `scopeParents` WeakMap——这是 jobs-local/commands/child-agent 硬 worker 依赖的根源。
