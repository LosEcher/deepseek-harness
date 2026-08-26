# Agent Note: Agent 控制协议（P0）

Status: superseded — implemented as `.agents/notes/implemented/architecture/2026-08-15-agent-control-p1.md` (Agent control Service Definition and Node worker supervisor P1)

[English](2026-08-15-agent-control-protocol-p0.md) | 中文

## 范围

[Agent worker 进程隔离](2026-08-15-agent-worker-process-isolation.md) 的 P0。本 Note 定义进程安全的 Agent 控制 Service Definition、worker wire schema、所有权表、generation 规则、背压、session lease 规则与本地 TypeScript adapter，并把每个直接 `Agent` consumer 分类。

## 从现有代码推导的协议面

Service Definition 从现有接口推导，而非发明：

### AgentRegistry 控制面（`packages/core/agent/src/index.ts`）

| 操作 | 现有形态 | worker 协议角色 |
|---|---|---|
| `create(options)` | async → `AgentHandle` | `agent/create` command |
| `resume(options)` | async → `AgentHandle` | `agent/resume` command |
| `register(agent)` | sync → disposer | worker 内部（发布发生在 worker 内） |
| `enter(agent, owner)` | sync → disposer | worker 内部 |
| `announce(agent)` | sync | worker 内部（发出 `agent/created`） |
| `get(id)` | sync → `Agent \| undefined` | read-model 查询 `agent/get` |
| `list()` | sync → `Agent[]` | read-model 查询 `agent/list` |
| `isOwnedBy(id, owner)` | sync → boolean | read-model 查询（subagent 父子） |
| `roots()` | sync → `Agent[]` | read-model 查询 |
| `setFactory(factory)` | sync → disposer | worker 内部（factory 永不过边界） |
| `withInitiator` / `withoutInitiator` | sync | worker 内部（initiator 归属是进程局部的） |

### Agent 控制面（`packages/core/agent/src/runtime-types.ts`）

| 操作 | 现有形态 | worker 协议角色 |
|---|---|---|
| `cancel(cause, options?)` | sync void | `agent/cancel` command（幂等） |
| `whenIdle()` | async → void | `agent/whenIdle` command（在 `drained` 强度的 quiescence 上 resolve） |
| `runMaintenance(task)` | async → T，回调 | **不能过边界**；要么 worker-local，要么由各 consumer 定义具名 maintenance command |
| `send(message, target, wakeup)` | sync void | `agent/send` command |
| `followup(message)` | sync void | `agent/followup` command |
| `steer(message)` | sync void | `agent/steer` command |
| `inject(message)` | sync void | `agent/inject` command |
| `session` / `inbox` / `ctx` | live 对象 | 永不过边界；只有事件投影会过去 |

### Session 控制面（`packages/core/session/src/index.ts`）

| 操作 | 现有形态 | worker 协议角色 |
|---|---|---|
| `append(type, data, ...)` | sync → event，同步通知 observer | worker 内部（唯一 writer） |
| `flush`（经 coordinator） | async | `session/flush` command；也是 `drain` 的一部分 |
| events / surface 读取 | sync 读 | read-model 投影，经已提交的 `session-event` 通知 |

### 通知（worker → 主进程）

| 通知 | Payload | 含义 |
|---|---|---|
| `ready` | protocol version、generation、config digest | worker 启动完成并持有 lease |
| `status` | agent id、generation、`idle`/`running` | 镜像 `agent/status` |
| `session-event` | agent id、generation、seq、已提交事件 | 持久化 append 已提交；受 receiver credit 限制 |
| `drained` | agent id、generation | quiescent + flushed + lease 可释放 |
| `fault` | agent id、generation、类型化错误 | worker 局部故障，supervisor 处理 |

## 所有权表

| 资产 | 所有者 | 备注 |
|---|---|---|
| Session 日志（JSONL 行） | worker（唯一 live writer） | lease 保护；见 lease 规则 |
| Session lease | 存活期间的 worker | epoch 限定；见 lease 规则 |
| Inbox | worker | 变更 worker 局部；主进程投影由事件派生 |
| Agent 作用域 Cordis context | worker | 需要 `agent.ctx` 的插件挂载在 worker 内 |
| `AgentDescriptor` | 主进程 | identity、backend（`local-ts`/`worker-ts`）、config digest |
| Generation 计数器 | 主进程签发、worker 回显 | 见 generation 规则 |
| Routing（Host/ACP/headless/subagent 入口） | 主进程 | 命令转译为 `agent/*` 调用 |
| 重启策略 | 主进程 | 崩溃 → lease 释放/证明 stale 后新 generation |
| Status + session-event read model | 主进程 | 有界投影，receiver credit |

## Generation 规则

1. 主进程按 worker 生命周期签发单调 generation。每次新 worker 启动都带全新 generation。
2. 每个 command、notification 和 frame 都携带 generation。主进程拒绝 retired generation 的 frame；worker 拒绝携带 retired generation 的 command。
3. generation 在以下时机退休：worker 干净退出、supervisor dispose、或 supervisor 在崩溃/分区后证明 lease stale。
4. worker 自身的 bridge 连接 generation（来自 `dsh-bridge-protocol`）就是同一个 epoch 身份；worker 协议不维护第二个计数器。
5. retired generation 的迟到 frame 永远不能改变当前状态：command 在主进程边界被拒、notification 在主进程边界被丢弃、append 在 lease 边界被拒。

## 背压

1. 每个 agent 的 command queue 有界。队列满时以类型化 `busy` 错误拒绝命令，而不是无限缓冲。
2. 向主进程 read model 重放的 `session-event` 受 receiver credit 限制：未确认的 credit 预算耗尽时 worker 暂停通知，收到 `stream/credit` 后恢复。
3. cancellation 与 fault 通知有优先级：不排在普通事件流量后面（复用 bridge cancellation 优先级）。
4. resume 时从 durable storage 的事件重放限制在可配置窗口 + resnapshot；read model 可请求完整 resnapshot 而非无限重放。

## Session lease 规则

P0 在两个 lease 候选间决策（见 worker 进程提案的所有权小节）：

- **候选 A — 旁路 lease 文件**（`dsh-session-store` 原型）：`<sessionId>.lease` 以 `create_new` 创建，含 owner/pid/acquired-at。简单、与进程无关，但崩溃后无 supervisor 清理则易留孤儿，且对 TypeScript coordinator 的进程内单写者模型不可见。
- **候选 B — 事件流所有权**：所有权表达为 session 事件（或所有权 envelope 字段），随会话一起重放。最后一个所有权事件指明当前 writer；回退不留孤儿 lease；崩溃恢复就是重放年龄。要求 TypeScript coordinator 把所有权事件当作单写者不变量，这是对 `session-persistence` 的语义变更。

两个 writer 的现状（代码已核实）：

- TypeScript `SessionPersistenceCoordinator` 通过**进程内 per-session promise chain** 串行化所有 per-session 操作（`coordinator.ts` 的 `chains: Map<SessionId, Promise<unknown>>`）；没有磁盘锁。单写者只在单进程承载 coordinator 时成立。
- Rust `dsh-session-store` lease 是**磁盘 `create_new` 文件**，含 owner/pid/acquired-at（`lease.rs`）；第二个获取者得到 `AlreadyHeld`，但目前没有任何进程拥有 staleness 证明（无 heartbeat、无 pid 存活检查）。

这正是双向切换不对称的根源：Rust worker 的磁盘 lease 对 TypeScript coordinator 不可见，TypeScript 的 promise chain 对第二个进程不可见。因此 P0 的 lease 决策同时决定跨进程故事：候选 A 需要 staleness 证明（owner pid 存活或 heartbeat）加 TS 侧对 lease 文件的识别；候选 B 让 session 日志本身做仲裁，彻底消除第二套机制。

### P0 lease 决策：候选 B（事件流所有权）

P0 为 worker 协议采纳**候选 B**。理由（以 P0 自己的话表述）：

1. **它消灭一个机制而不是增加一个。** 候选 A 在 TypeScript promise chain 之上叠第三套单写者机制（磁盘 lease 文件），且仍需 staleness 证明加 TS 侧识别才能切换安全。候选 B 让 session 日志——双方都会重放的唯一产物——做仲裁；回退不留孤儿，崩溃恢复就是重放年龄。
2. **它是事件溯源选项。** DSH 的 session 日志是 durable source of truth 和扩展面。所有权作为事件（或 envelope 字段）是该日志的投影，而非可能与其漂移的旁路通道。
3. **它把不对称缺口风险变成不变量。** 上述缺口消失：TypeScript coordinator 获得所有权事件检查，而不是需要发现一个它从未创建的外部文件。

接受的代价：`session-persistence` coordinator 必须把所有权事件当作单写者不变量（语义变更，明确限定在 worker 协议的 session 面）；Rust `dsh-session-store` 外部 lease 文件仍作为叶子原语（P3）供未采纳流式所有权的 coordinator 使用，但它不再是 worker 协议 lease。

任一候选下都成立的规则：

1. 恰好一个 generation 持有 lease 并 append 事件。第二个获取者被拒（A 下为 `AlreadyHeld`；B 下为不变量违规）。
2. 断开或崩溃的 worker 不能无限期持有 lease：A 下 supervisor 必须先证明 stale（owner pid 死亡或 heartbeat 过期）才允许新 generation 获取；B 下由重放年龄决定。
3. `drained` 是计划内切换后释放 lease 的唯一状态；仅进程退出永远不构成 durability 证明。
4. 后端切换（local-ts ↔ worker-ts）是 drain + flush + lease 释放 + 以新 generation resume，绝不 heap 迁移、绝不隐藏 fallback。

## Wire schema（bridge 映射）

worker 协议是 `dsh-bridge-protocol` 之上的 service 面，不是第二套 IPC。每个协议角色映射到既有 bridge message 类型：

| worker 协议角色 | bridge message | Payload 形态 |
|---|---|---|
| `agent/create` / `agent/resume` | `Call`（service=`agent`） | `{ id?, options: CreateAgentOptions \| ResumeAgentOptions, owner }` |
| `agent/send` / `followup` / `steer` / `inject` | `Call`（service=`agent`） | `{ message: UserMessage, target?, wakeup? }` |
| `agent/cancel` | `Cancel`（id = agent command id） | — |
| `agent/whenIdle` | `Call`（service=`agent`） | — |
| `session/flush` | `Call`（service=`session`） | — |
| `agent/get` / `list` / `roots` / `isOwnedBy` | `Call`（service=`agent`，read-model 查询） | 查询参数 |
| `ready` | `Hello` + 首次 `ContributionRegister`（plugin=`agent-worker`） | `{ protocolVersion, generation, configDigest }` |
| `status` / `drained` / `fault` | `EventInvoke`（event=`agent/status` 等） | 类型化 payload |
| 已提交 `session-event` | `EventInvoke`（event=`session/event`） | `{ seq, event }`，由 `StreamCredit` 流控 |
| `drain` | `Dispose`（id = agent command id） | — |
| `drained` ack | `Quiescent` | — |

任何 payload 中 function 和 Cordis context 永不过边界；`UserMessage` 与事件 payload 只含 JSON 可序列化值（`user/message` 等已受 session append 的 JSON 强制检查约束）。`runMaintenance` 回调是唯一没有 wire 形态的操作：需要它的 consumer 要么 worker-local，要么定义为该 consumer 自己的具名 maintenance command。

## 本地 TypeScript adapter

`local-ts` 仍是同一 Service Definition 的一种实现：上面的 registry 与 Agent 面就是本地 adapter。worker 协议的命令与本地操作 1:1 映射；一致性通过同一份正/负向 fixture 语料对两个 backend 运行来断言。

## Consumer 分类

见[附录](#appendix-consumer-classification)中的 P0 分类表（由逐包审计汇总）。

- **worker-local**：必须搬进 worker；P1 worker composition 必须挂载它们。
- **command-driven**：可改造成主进程发出的 `agent/*` 调用；无需 live 对象。
- **read-model-driven**：主进程维护投影；完全不访问 Agent。
- **type-only**：只引用类型；不受影响。

关键审计发现：

- **不存在纯 command-driven 的现有消费者。** 每个现有直接消费者要么触碰 live 对象（session/inbox/ctx）、要么读投影、要么纯类型。RPC 命令层是新建而非平移——控制方法调用点都在 worker-local 文件内部（agent-loop 自建自管）。
- **session 写面一票否决。** hooks 双桥（`session.append` 写 hook/invoked+result）、llm-retry、web-search、checkpoint-policy、api-proxy、agent-loop 都写 session 事件；写面直接归入 worker-local。
- **inbox 可变面稀少且集中。** `agent.inbox.prepend/remove/replace` 只出现在 agent-instructions 与 api-proxy——最小、最高价值的搬迁目标。
- **需定夺的边界件**列在附录（agent-lookup、core/tools scope 路由、workflow host、tool-cordis/tool-terminal、web-search initiator、shutdownDrain、活体对象 WeakMap 键）。

## 验收标准

- 上面的 Service Definition 表与现有接口一致；分类 consumer 所需的操作都有具名 command 或 worker-local 归宿。
- 仓库中每个直接 `Agent` consumer 都已分类；分类可复现（每行引用决定它的文件与用法）。
- lease 候选决策已记录原因（本 Note 的 lease 规则小节）。
- wire schema 的正/负向 fixtures 已存在（对齐 `native/dsh/contracts` 风格），并对 `local-ts` 与 `worker-ts` 都通过。

Fixtures 位于 `packages/core/agent/contracts/`（`agent-worker-manifest-source.json`、`agent-worker-manifest.json`、`agent-worker-positive.json`、`agent-worker-negative.json`），遵循 native contracts 模式：manifest source、digest 校验的 manifest、以及 frame 为 bridge message 的正/负向用例列表。manifest digest 与 freshness check 在第一个 adapter 消费它们时接入（P0/P1 的 local adapter）。

### P0 已决策 vs 留待评审的决策

P0 记录以下为**已决策**（记录于本 Note）：协议面表格、bridge 映射 wire schema、epoch 统一所有权表、generation 规则、背压规则、lease 决策（候选 B）、本地 adapter 形态、以及带 12 项边界件的 consumer 分类。

人工评审已确认 P0 建议：lease 候选 B，以及附录全部十二项边界件。[P1](../../implemented/architecture/2026-08-15-agent-control-p1.md) 实现了 Service Definition、监督器与两个 backend。

## 风险

- **分类错误**：标为 command-driven 却偷偷改 `agent.session` 或 `agent.inbox` 的 consumer 会重新制造隐式 remote-object API。每个 command-driven 行必须引用其使用的确切操作。
- **runMaintenance 回调 consumer**：传闭包的 consumer 要么整体 worker-local，要么在 P1 前重设计为具名 maintenance command。
- **候选 A 的孤儿窗口**：supervisor staleness 证明必须在压力测试前定义；候选 B 消除窗口但改变 TypeScript coordinator 语义。
- **事件滞后**：read model 可能落后于繁忙 worker；receiver credit 与 resnapshot 规则必须在 P1 压力测试中验证。

## 附录：Consumer 分类

<a id="appendix-consumer-classification"></a>

由四个只读审计批次汇总（core/context；产品插件；入口/宿主/客户端；工具/终端/技能/test-support）。每行引用决定分类的用法。`Agent` = `session`/`inbox`/`ctx` 三个 live 对象 + 控制方法（`cancel`/`whenIdle`/`runMaintenance`/`send`/`followup`/`steer`/`inject`）。

### 批次 A — core 与 context（31 文件）

| 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|
| agent/src/index.ts (AgentRegistry) | `agent.id`、`agent.session.id`、`scopeTarget(agent, agent)`、`this.get(id)?.ctx`、`AsyncLocalStorage<Agent>` | 读（身份/ctx） | worker-local | 活体注册表：以 agent 对象为 store/scope 键、对外交出 `agent.ctx` |
| agent/src/dispatch.ts | `scopeTarget(agent, agent)` 注入 payload | 读（identity） | worker-local | agent 对象耦合为 scope 载体与事件 subject |
| agent/src/inbox.ts (Inbox) | `session.append('agent/inbox/spliced')`、next-turn/next-step 可变列表 | 写 | worker-local | `agent.inbox` 实现本体 |
| agent/src/model-selection.ts | `installModelSelection(agentCtx, …)` 挂 waterfall 监听 | 读（ctx 挂载） | worker-local | agent 作用域装配 |
| agent/src/consumed-work.ts | 纯函数折叠 `SessionEvent[]` | — | type-only | 无实例用法 |
| agent/src/types.ts | declare 事件词汇 | — | type-only | 纯类型 |
| agent/src/invariant.ts | `agent/status` 监听 + `WeakMap<Agent, AgentStatus>` | 读 | read-model-driven（边界） | 身份键可改 sessionId |
| agent-loop/src/agent.ts (ReactLoopAgent) | 实现 Agent 全部面：session.append、inbox.splice/claim、dispatch、全部控制方法 | 写 | worker-local | worker 的核心 driver |
| agent-loop/src/index.ts (AgentLoop) | `agent.ctx.sessions.enter/announce`、`loopCtx.agents.enter`、`machine.drainToIdle/cancel/whenIdle`、`setup?.(agent.ctx)` | 写 | worker-local | 工厂+生命周期所有者；`shutdownDrain`/`markProcessExiting` 是 CLI RPC 化候选 |
| agent-loop/src/runtime-context.ts | 读 `session.surface/events`、`ctx.on('session/event')` | 读 | worker-local | 回合内投影，subject identity 绑定 worker |
| agent-loop/src/invariant.ts | `ctx.sessions.get(sessionId)`、读 events/deriveMessages | 读 | read-model-driven（边界） | 依赖 `ctx.sessions` 活体查询 |
| agent-default-model/src/{index,invariant}.ts | 纯配置服务 | — | type-only | 无 Agent 引用 |
| agent-tool-presentation/src/{index,invariant}.ts | `ctx.tools.presentAs()` | — | type-only | host 平面 |
| core/tools/src/index.ts | `chainLayers(exec.agent)`、`scopeTarget(this, exec.agent)` | 读（identity 路由） | worker-local（身份依赖，需定夺） | scope 链符号属性挂在 agent 对象上；注册表按设计留 host 平面 |
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

批次 A 汇总：worker-local 14 / read-model-driven 6 / type-only 11 / command-driven 0。

### 批次 B — 产品插件（34 文件）

| 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|
| subagent/src/index.ts | 仅 `parent: Agent` 类型透传 | 读（仅传引用） | type-only | Service 定义层 |
| subagent/src/child-agent.ts | `parent.ctx.get('agentPresets'/'sandboxPolicy'/'approval')`、`parent.session.header`、`parent.options` | 读 | worker-local | 从 parent 活体 ctx 读服务 + 读 session.header |
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

批次 B 汇总：worker-local 15 / command-driven 1 / read-model-driven 8 / type-only 10。

### 批次 C — 入口、宿主、客户端（26 文件）

| 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|
| acp/acp/src/index.ts | followup/whenIdle/cancel、`agents.get(id) !== agent` 校验 | 读+控制 | command-driven | ACP 桥只驱动自有 agent |
| api/remotes/src/index.ts | 纯 re-export | — | type-only | 无实例 |
| api/remotes/src/agent-lookup.ts | `ctx.agents.get/resume`、session.header 读、`configureHost('agent', … => agent.ctx)` | 读+工厂+ctx 移交 | worker-local（边界，需定夺） | 「session id → 活体 Agent/ctx」解析器，worker 化后必须改远程投影 |
| api/remotes/src/client/index.ts | 纯类型 | — | type-only（remote projection） | client 装配面 |
| host/apiproxy/src/index.ts | 只构造 createApiProxy | — | type-only（委托） | 语义随 api-proxy.ts |
| host/apiproxy/src/api-proxy.ts | session.append、inbox.replace/remove、inbox.nextTurn/nextStep 读、session.events 读、steer/followup/cancel、`WeakMap<Agent,…>` | 写+ctx+控制 | worker-local | session/inbox/ctx 三面全触的重度消费者 |
| bundle/headless/src/index.ts | installModelSelection(agentCtx)、whenIdle、followup、flush | 读+ctx+控制 | worker-local | 已是 worker 原型 |
| sdk/server/src/server.ts | followup、session.id 读 | 读+控制 | command-driven | JSON-RPC 只 followup 驱动 |
| extensions/cordis-host-runner/src/index.ts | steer/inject、agent.id 比对 | 控制+读 | command-driven | 动态插件反馈 |
| extensions/cordis-host-runner/src/inspect-registry.ts | agent.id 读、透传 live agent 给 provider 回调 | 读 | read-model-driven（需定夺） | 透传是同进程依赖 |
| extensions/tool-cordis/src/index.ts | `exec.agent` 转发 runner、agent/pre-step 读 | 控制+读 | command-driven（需定夺） | 工具执行世界归属未定 |
| extensions/tool-cordis/src/api-catalog.ts | 无 | — | type-only（数据） | 生成字符串字面量 |
| extensions/tool-cordis/src/inspect.ts | agent 作 snapshot scope 参数 | 读 | read-model-driven | 自省渲染 |
| client/runtime/steering-history.ts、ui-conversation/conversation-nodes/inbox.ts、ui-trajectory/trajectory-message-definitions.ts | 仅 import 类型 + 事件重放 | — | type-only（remote projection） | client 侧投影 |
| preset/agent-presets/src/index.ts | `composedPreset(agent.ctx)`、scope 链操作、agent/created 监听 | 读+写 scope 绑定 | worker-local | 预设组成系统挂 agent.ctx |
| preset/agent-presets/src/authoring.ts、discovery.ts、metadata.ts、session.ts | 纯 fs/纯函数 | — | type-only | 无 Agent |
| preset/agent-presets/src/invariant.ts | 只读 agent.id/agent.ctx 断言 | 读 | read-model-driven | invariant 伴生 |
| preset/agent-presets/src/mount.ts | `agentCtx.plugin(PresetTree, config)` | ctx 挂载 | worker-local | 组合核心 |
| examples/acp-demo/src/index.ts、agent-spine-demo/src/{index,invariant}.ts | 纯 ctx.plugin 编排 | — | type-only | 组合示例 |

批次 C 汇总：worker-local 5 / command-driven 4 / read-model-driven 3 / type-only 14。

### 批次 D — 工具、终端、技能、workflow、hooks、test-support（22 文件）

| # | 文件 | 使用面 | 写/读 | 分类 | 理由 |
|---|---|---|---|---|---|
| 1 | shell/tool-bash/src/index.ts | header.cwd 读、agent 作身份令牌传 sandboxPolicy/approval/jobs | 读 | read-model-driven | 只读 header 派生，令牌可改 agent.id |
| 2 | shell/tool-bash-persistent/src/index.ts | header.cwd 读、`owner.ctx.effect(...)`、`WeakMap<Agent,…>` | 读+ctx 挂载 | worker-local | agent.ctx 挂 effect + 身份键 |
| 3 | shell/tool-pwsh/src/index.ts | 与 tool-bash 同构 | 读 | read-model-driven | 镜像 |
| 4 | terminal/terminal/src/index.ts | `SessionRecord.owner: Agent`、Map/WeakSet 身份键、`owner.ctx.effect(...)`、`isLiveOwner` 对象同一性 | 写+ctx | worker-local | 硬依赖同进程 identity |
| 5 | terminal/terminal/src/types.ts | 纯类型 | — | type-only | 无实例 |
| 6 | terminal/terminal-bash/src/index.ts | `owner.ctx.on('internal/dispatch',…,{global:true})`、WeakMap、session 同一性 | 读+ctx | worker-local | 挂 ctx 监听 + 身份键 |
| 7 | terminal/tool-terminal/src/index.ts | 仅 requireAgent 后转发 `ctx.terminals.*` | 无 | command-driven（需定夺） | 落脚点取决于 terminals 服务去向 |
| 8 | skill/tool-skill/src/index.ts | header/surface/events 读、agent 作 scope 键 | 读 | read-model-driven | 只读投影 |
| 9 | workflow/workflow/src/runtime-types.ts | 纯类型、`WorkflowStartRequest.parent: Agent` | — | type-only | parent 字段是活对象引用 |
| 10 | workflow/workflow-worker-thread/src/host.ts | 转发 `parent: Agent` 给 subagents.start | 无 | command-driven（需定夺） | child-agent 读 parent.session/ctx，深度耦合 |
| 11 | hooks/hooks-claude-code/src/index.ts | `session.append`（hook/invoked+result）、inject/steer、Map 身份键 | 写+控制 | worker-local | 回合内 session 写面一票否决 |
| 12 | hooks/hooks-codex/src/index.ts | 同构 | 写+控制 | worker-local | 同上 |
| 13-14 | test-support/agent-loop-testkit/src/{index,invariant}.ts | 无 | — | type-only | 零接触 |
| 15 | test-support/loader-smoke/src/agent-turn.ts | whenIdle/followup、session 身份、flush | 控制+读 | command-driven | 测试编排可 RPC 化 |
| 16 | preset/agent-presets/src/（index/mount/invariant） | agent.ctx 重使用 | ctx 挂载 | worker-local | 与批次 C 重叠 |
| 17 | context/agent-instructions/src/index.ts | inbox 写 + 读 | 写+读 | worker-local | 与批次 A 重叠 |
| 18-22 | agent-instructions/state.ts、time-context、session-reference/{index,projection}、tmux-context | 只读 | 读 | read-model-driven | 与批次 A 重叠 |

批次 D 汇总：worker-local 7 / command-driven 3 / read-model-driven 8 / type-only 4（部分行与批次 A/C 重叠）。

### 汇总计数

| 分类 | 批次 A (core/context) | 批次 B (产品插件) | 批次 C (入口/宿主/客户端) | 批次 D (工具/终端/技能) |
|---|---|---|---|---|
| worker-local | 14 | 15 | 5 | 7（含与 A/C 重叠 2） |
| command-driven | 0 | 1 | 4 | 3 |
| read-model-driven | 6 | 8 | 3 | 8（含与 A 重叠 5） |
| type-only | 11 | 10 | 14 | 4 |
| **合计** | 31 | 34 | 26 | 22 |

审计文件总数 113（部分行在批次 A 与 D 间重叠）。去重后核心 worker-local ≈ 33；command-driven ≈ 7（另加新建 RPC 面）；read-model-driven ≈ 17；type-only ≈ 29。

### 需人定夺的条目

每项都带 P0 建议；逐项确认或推翻。

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

交叉事实：hooks 双桥经 `appendHookInvoked/appendHookResult` 写 session（hook-protocol/src/events.ts:75-104）；child-agent.ts:107-108 读 parent.session.header/ctx；goal/commands 已有 Typert Gateway 暴露控制端点（SessionId→活体 Agent 解析），可作 P0 命令化通道起点；现有代码**无纯 command-driven 消费者**——RPC 层是新建而非平移；`scopeOf(ctx)` 读 `ctx[kScope]` 符号标签（core/scope/src/index.ts:154），`ScopedLayers.merge(agent,…)` 以 Agent 对象直接作作用域键走 `scopeParents` WeakMap——这是 jobs-local/commands/child-agent 硬 worker 依赖的根源。
