# Agent Note: Agent worker 进程隔离

Status: proposed

[English](2026-08-15-agent-worker-process-isolation.md) | 中文

## 问题

现有 `Agent` 接口是同进程对象图，不是进程安全的控制 API。它暴露可变的 `Session`、`Inbox` 和 Agent 作用域 Cordis `Context`；`Session.append()` 在返回前同步提交并通知同进程 observer。Host API、compaction、goal、preset、subagent 和其他产品插件会直接读取或修改这些对象。因此，只把 `AgentRegistry.setFactory()` 换成 RPC 代理虽然保留了类型，却会破坏时序、对象 identity 和注册要求。

CLI 进程还同时负责组合插件树，并在关闭时直接排空 agent loop。一个 Agent 内的故障或不协作任务因此可以拖住承载其他 Agent、Host API 和 composition lifecycle 的同一进程。Rust execution sidecar 可以隔离选定的文件系统或 subprocess 工作，但不能把 Agent loop、session writer 或 Agent 作用域插件与主进程隔离。

Rust 迁移还有一项独立的替换要求：每个 Rust 实现必须能与 TypeScript 实现并存选择，并通过同一组一致性验证。在进程安全的 Agent 协议存在之前把 `agent-loop` 搬到 Rust，会在一步内同时进行语言迁移、生命周期重设计和插件搬迁。

## 提案

新增进程安全的 Agent 控制能力，并先用 Node worker process 实现。Node 继续作为 Cordis composer 和主进程。每个隔离 Agent 在自己的子进程中运行完整的 TypeScript Agent composition，包括 live `Agent`、session、inbox、Agent 作用域 Cordis context、loop，以及所有依赖这些同进程对象的插件。主进程负责 supervision、routing、外部可见状态和 read model；它不会持有一个声称实现当前 `Agent` 接口的远程对象。

现有本地 TypeScript runtime 继续作为同一控制能力的一种实现。profile 和 preset 在创建 Agent generation 时选择 `local-ts` 或 `worker-ts`。Rust Provider 仍按 [Cordis 背后的 Rust capability Provider](2026-08-15-rust-host-replacement.md) 作为任一 composition 内的普通 capability provider；Rust sidecar 不计作 Agent 隔离。

### 进程所有权

worker process 是该 Agent generation 唯一的 live-session writer。它拥有 session lease、同步 append 语义、inbox mutation、scoped effect、model loop、tool dispatch、persistence flush 和有序 dispose。读取 `agent.session`、`agent.inbox` 或 `agent.ctx` 的插件挂载在 worker 内，而不是通过 RPC 调用。

主进程拥有 `AgentDescriptor`、worker generation、来自 Host/ACP/headless/subagent entrypoint 的 routing、restart policy，以及有界的 status/session event projection。主进程 consumer 通过 Agent 控制能力请求操作。当前接收 callback 或 mutable object 的操作，包括 `runMaintenance()` 和 Host 侧直接 session mutation，必须改成具名 worker command 或保留在 worker 内；function 和 Cordis context 永不过进程边界。

所有权身份收敛为同一个单调递增 epoch：bridge 连接 generation、worker generation 与 session lease owner 是同一身份的三个视角。退休的 epoch 拒绝所有迟到 frame、command 与 append。session lease 本身有两个候选，由 P0 决定：`dsh-session-store` 中已做原型的旁路 lease 文件，或随会话一起重放的 session 事件流所有权事件。流式所有权是事件溯源选项：最后一个所有权事件指明当前 writer，回退不留孤儿 lease，崩溃恢复只是重放年龄。只有 P0 记录了事件形式为何无法表达所需 lease，才保留旁路文件。

初版由一个子进程承载一个 Agent。这样 worker crash 的 failure domain 只有一个 session，也让进程终止成为最后手段的有效取消机制。后续 pooled-worker 设计需要独立证据，因为它会让一个 Agent 的故障影响 pool 内其他 Agent。

### Worker 协议

第一版协议定义 `create`、`resume`、`send`、`followup`、`steer`、`inject`、`cancel`、`drain`、`dispose` 和 read-model query command。worker notification 包括 `ready`、`status`、已提交的 `session-event`、`drained` 和 `fault`。每个 frame 都携带 protocol version、Agent id、worker generation、适用时的 request id，以及带类型的 terminal result 或 error。

主进程拒绝 retired generation 的 frame。command delivery 按 Agent 有序，cancellation 幂等，queue 和 event replay 受 receiver credit 限制，断开连接的 worker 不能无限期保留 live session lease。`drained` 表示 Agent 已 quiescent、必需的 session event 已 flush，并且 lease 可以释放；它强于 idle status notification。

worker 协议不是第二套 IPC。命令是产品 bridge 上 service 为 `agent` 的 `call` 帧，method 名为 `send` 或 `steer`；session-event 通知是 `event/invoke` payload；`cancel` 与 `drain` 复用 bridge 的取消及 `dispose`/`quiescent` 生命周期。因此一套 framing、credit、cancellation 与 generation 原语同时服务 Rust Provider 和 Agent worker。

崩溃恢复在旧 lease 释放或被证明 stale 后启动新 generation，并从 durable session resume。worker 协议不传递 JavaScript heap state。未闭合回合恢复和重复 chunk 处理遵循 [事件溯源式回合切换](2026-08-14-event-sourced-turn-switching.md)；在该提案实施前，回合中途崩溃仍表现为当前 repair behavior。

### 后端切换

`local-ts` 和 `worker-ts` 使用同一 Agent 控制一致性验证，并产生相同的 public session event、snapshot、error identity、cancellation outcome 和 drain result。backend selection 在 generation 启动时从 profile 或 preset configuration 显式解析并写入 diagnostics；它不是隐藏 fallback。

切换现有 Agent 是 drain-and-resume 操作，不是 live heap migration。在 idle checkpoint，当前 backend drain 并 flush、释放 session lease，再由选中的 backend 以新 generation resume 同一 session。active turn 期间，切换要等待 drain；只有 event-sourced turn switching 提供 pending-turn behavior 后才能使用该行为。目标 backend 启动失败时保持 durable session 不变并报告失败；只有显式配置并记录后才允许 automatic fallback。

### 优先工作队列

| 优先级 | 工作 | 退出条件 |
|---|---|---|
| P0 | 定义 Agent 控制 Service Definition、worker wire schema、所有权表、generation rule、backpressure、session lease rule 和本地 TypeScript adapter | 协议具备正向和负向 fixture；每个当前直接 `Agent` consumer 都被归为 worker-local、command-driven 或 read-model-driven |

P0 的协议定义、所有权表、generation 规则、背压、lease 规则、wire schema、fixtures 与 consumer 分类见 [Agent 控制协议（P0）](2026-08-15-agent-control-protocol-p0.md) Note。
| P1 | 构建 Node worker supervisor 和 TypeScript worker 实现；增加显式 `local-ts` 与 `worker-ts` profile/preset selection | 两个 backend 通过相同的无 key Agent lifecycle 与 assembled snapshot case；杀死一个 worker 后主进程和其他 Agent 仍可用；drain-and-resume 保持唯一 session writer。[P1 实现](../../implemented/architecture/2026-08-15-agent-control-p1.md) 交付了 Service Definition 与两个 backend；已交付 profile 仍使用进程内 `ctx.agents`，组装快照仍走该路径，直到 worker 挂载产品组合。 |
| P2 | 用 Rust 实现替换隔离 execution world 的 filesystem、subprocess、sandbox 和 PTY Provider，同时保留 TypeScript Provider | Rust 与 TypeScript Provider 通过同一 capability conformance suite；profile 可以选择任一 Provider；cancellation、stream order、process-tree cleanup 和 dispose 行为一致 |
| P3 | 增加 atomic replacement、file lock、JSONL/SQLite operation 和 session lease 的 Rust persistence primitive，再按测量结果用于现有 TypeScript coordinator 背后 | storage fixture 与 crash case 一致；拒绝第二个 writer；settings、credentials、attachment 和 spill store 可以独立启用并切回 TypeScript |
| P4 | 分别评估 LLM transport、web fetch/search、MCP 和 LSP transport | 只有具备已记录的 latency、throughput、memory、crash-isolation 或 packaging 证据及 Provider 专项 conformance suite 时才迁移 |
| Deferred | session semantics、agent-loop、tools、system-prompt、scope、Cordis composition、Host client 和产品插件留在 TypeScript | 只在 worker 协议稳定且测量表明剩余 Node 实现阻止一项明确产品要求后重新考虑 |

P0 和 P1 是声称 Agent 隔离的前置条件。P2 和 P3 可以基于现有 Rust bridge 制作原型，但它们不会改变该结论，也不能排在 worker conformance proof 前面。Deno 不是实现或兼容性目标。

## 考虑过的替代方案

**返回一个类型为当前 `Agent` 的远程对象。** 否决，因为同步 session publication、可变 inbox access、scoped Cordis registration、object identity 和接收 callback 的方法无法通过 RPC 保持当前行为。

**先用 Rust 重写 `agent-loop`。** 否决，因为在进程协议和 conformance oracle 存在之前，它会把进程隔离与面向模型 loop 的新 semantic owner 绑在一起。Rust execution 和 persistence Provider 不搬动 loop 也能提供隔离与资源控制收益。

**把 Rust execution sidecar 当作 Agent worker。** 否决，因为当前 sidecar 只拥有选定的 Provider call。live Agent、session writer、inbox、scoped plugin 和 loop 仍在 Node 主进程。

**第一版就在一个 worker 中运行多个 Agent。** 否决，因为 process crash 或强制终止会影响无关 Agent，无法证明所需的 fault isolation。测量每 Agent process 成本后可以重新考虑 pooling。

**替换 Node 或使用 Deno 作为进程根。** 本提案否决。Node 继续承载 Cordis composition 和现有 TypeScript plugin；Deno 不在目标矩阵内。

## 验收标准

- 存在版本化 Agent worker 协议和进程安全的 Agent 控制 Service Definition；当前 `Agent` 接口仍被明确限定为 worker-local。
- `local-ts` 和 `worker-ts` 是显式 profile/preset 选项，并通过相同的 lifecycle、cancellation、drain、resume、error、session-event 和无 key snapshot conformance case。
- 终止一个 Agent worker 不能终止主进程或另一个 Agent；supervisor 会报告 fault，并能从 durable state resume 新 generation。
- 恰好一个 generation 持有 session lease 并 append event。retired generation 的迟到 frame 和 command 不能修改当前状态。
- command 与 event queue 有界，receiver backpressure 经过测试，cancellation 和 fault notification 不会被普通 event traffic 阻塞。
- backend 切换执行 drain、flush、release 和 resume。它永不依赖 heap transfer，也不会在失败后静默更换 backend。
- 每个 Rust Provider 都能与其 TypeScript Provider 独立并存选择，并且在 capability conformance 和 assembled snapshot 通过前不能成为已出厂默认值。
- 文档和 diagnostics 区分 Agent isolation、Rust Provider isolation、configured backend、effective backend、worker health 和 recovery outcome。

## 风险

- **插件位置错误。** 如果主进程插件仍读取 `agent.session`、`agent.inbox` 或 `agent.ctx`，就会重新制造隐式 remote-object API。P0 必须在 P1 修改 profile 前分类每个直接 consumer。
- **Session split brain。** crashed 或 partitioned worker 可能看似已死但仍持有资源。generation check、exclusive lease、stale-owner rule 和 fail-closed resume 必须一起提供。
- **事件延迟与内存增长。** Host read model 可能落后于繁忙 worker。stress test 前必须规定 receiver credit、bounded replay、durable sequence cursor 和 resnapshot rule。
- **关闭状态歧义。** idle、drained、flushed、disposed 和 process-exited 是不同状态。协议必须暴露 supervisor 所需的每个 transition，且绝不能从 process exit 推断 durability。
- **每 Agent 进程成本。** startup time、resident memory、file descriptor 和 sidecar 数量可能限制密度。测量可能支持 warm worker 或 pooling，但这些设计必须保留显式 isolation level。
- **配置 generation 漂移。** HMR 可以在 worker 仍使用旧 generation 时改变主进程 composition。创建时记录 effective config digest；不兼容变更必须 drain-and-resume，而不是局部 mutation。
- **重复 semantic owner。** Rust Provider 和 worker transport 必须使用从 TypeScript Service Definition 生成的 schema 或 fixture。手工维护副本会导致 `local-ts`、`worker-ts` 和 Rust 行为分歧。
