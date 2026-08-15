# P0 consumer classification — batch: entrypoints / host / client (audited)

Audit scope: 26 files under acp, api/remotes, host/apiproxy, bundle/headless, sdk/server,
extensions/cordis-host-runner, extensions/tool-cordis, client (remote projections),
preset/agent-presets, examples. Classification per the P0 Agent control protocol note
(worker-local / command-driven / read-model-driven / type-only).

## Table

| 文件 | 使用面（session/inbox/ctx/方法名） | 写/读 | 分类 | 一句话理由 |
|---|---|---|---|---|
| `packages/acp/acp/src/index.ts` | `agent.session`（id/identity 对比）、`agent.id`、`followup`、`whenIdle`、`cancel`、`ctx.agents.get` identity 校验 | 只读 + 控制方法 | **command-driven** | ACP 桥只通过 `followup`/`whenIdle`/`cancel` 驱动自有 agent，session 仅用于关联校验，不触碰 session/inbox 写面、不挂 ctx |
| `packages/api/remotes/src/index.ts` | 无（纯 re-export + 事件 allowlist 形状门 + 空 `apply()`） | — | **type-only** | 只转发类型与常量，不触碰任何 Agent 实例 |
| `packages/api/remotes/src/agent-lookup.ts` | `ctx.agents.get/resume`（create/resume）、`agent.session.header`（读）、`agent.id`、`agent.ctx`（`typert.contexts.configureHost('agent', … => resolveAgent(sid).ctx)`）、`isOwnedBy` | 读 + 工厂 + **把真实 `agent.ctx` 交给 RPC 层** | **worker-local（边界）** ⚠️ | 它是「session id → 进程内真实 Agent/Session/ctx」的解析器：`configureHost` 把 live `agent.ctx` 直接注入 Typert host context，属于同进程对象移交，worker 化后必须改成远程投影；create/resume 部分本身是 command-driven |
| `packages/api/remotes/src/client/index.ts` | 无 Agent 使用（纯类型 re-export + `ctx.remote.$mount`） | — | **type-only（remote projection）** | Client 侧装配面，全程无 Agent 实例，只消费 Host 远程类型 |
| `packages/host/apiproxy/src/index.ts` | 无直接 Agent 使用（只构造 `createApiProxy(ctx, defaults)` 并转发服务面） | — | **type-only（委托）** | `ApiProxyService` 自身不直接消费 Agent，全部落在 api-proxy.ts |
| `packages/host/apiproxy/src/api-proxy.ts` | `agent.ctx`（`installModelSelection(agent.ctx,…)`、`presets.recompose(agent.ctx,…)`）、`agent.session.append('agent-preset/selected')`、`agent.inbox.replace/remove`、`agent.inbox.nextTurn/nextStep/hasPending`（读）、`agent.session.events/deriveMessages/requestHeader`（读）、`steer`/`followup`/`cancel`、`agent.status`、`WeakMap<Agent,…>` 两处 | 读 + **写**（session append、inbox 可变面）+ ctx 挂载 + 控制方法 | **worker-local** | 唯一同时触碰 session 写面（append）、inbox 写面（replace/remove）、agent.ctx（装服务/重排 preset）的重度消费者，且以 Agent 实例为 WeakMap key（同进程 identity），必须整体进 worker |
| `packages/bundle/headless/src/index.ts` | setup 里 `installModelSelection(agentCtx,…)`（agent.ctx 挂服务）、`agent.session.seq/events`（读）、`whenIdle`、`followup`、`sessions.flush(agent.session)` | 读 + ctx 挂载 + 控制方法 | **worker-local** | 本身就是独立一次性执行进程（worker 的原型）：setup 往 agent.ctx 装模型选择服务，只能与 agent 同进程 |
| `packages/sdk/server/src/server.ts` | `handle.agent.followup`、`agent.session.id`（通知）、`agent.id`、`agents.get(id) !== agent` identity 校验、`subagent/end` 里 `parent.session.id` | 只读 + 控制方法 | **command-driven** | JSON-RPC server 只通过 `followup` 驱动，session 只读 id/事件，无 inbox/ctx 触碰 |
| `packages/extensions/cordis-host-runner/src/index.ts` | `agent.steer(...)`（4 处）、`agent.inject(...)`（injectUserContext）、`agent.id`、`agents.get(agent.id) !== agent` identity | 控制方法（steer/inject）+ 只读 id | **command-driven** | 动态插件服务只通过 `steer`/`inject` 反馈，ownership 用 `agent.id` 比对，不碰 session/inbox/ctx |
| `packages/extensions/cordis-host-runner/src/inspect-registry.ts` | `agent.id`（pending query 关联）、把 live `agent` 原样传入 provider 回调 `registration.query(method, input, { agent, signal })` | 只读（id）+ 透传实例 | **read-model-driven** ⚠️ | 文件自身只读 `agent.id` 做关联并把 agent 透传给已注册 provider；透传 live Agent 是同进程依赖 |
| `packages/extensions/tool-cordis/src/index.ts` | `exec.agent`（ToolExecution 注入的真实 Agent）、`agent.id`、把 agent 传给 runner 服务、`agent/pre-step` 只读 messages | 控制（经 runner 服务）+ 只读 id | **command-driven** ⚠️ | 工具层把 live `exec.agent` 当 handle 转发给 runner 服务，本文件无 session/inbox/ctx 直触 |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | 无（所有 `Agent` 字样均为生成字符串字面量） | — | **type-only（数据）** | 生成式 API 目录数据文件，运行时零 Agent 触碰 |
| `packages/extensions/tool-cordis/src/inspect.ts` | `agent?: Agent` 仅作 `snapshot(agent)` 的 scope 参数；其余读 `ctx.reflect.store`/`ctx.registry`/`ctx.tools.schemas(scope)` | 只读 | **read-model-driven** | 纯运行时自省渲染：agent 只是查询 scope 键 |
| `packages/client/runtime/src/client/sessions/steering-history.ts` | 仅 import `InboxTarget`（type），重放 `agent/inbox/spliced` 会话事件 | — | **type-only（remote projection）** | Client 侧纯事件重放，只引用类型 |
| `packages/client/ui-conversation/src/client/conversation-nodes/inbox.ts` | 仅 import `InboxTarget`（type），消费 `agent/inbox/spliced` 会话事件 | — | **type-only（remote projection）** | 会话事件驱动的前端投影节点 |
| `packages/client/ui-trajectory/src/client/trajectory-message-definitions.ts` | 仅 `import type {} from '@deepseek-ai/dsh-agent/types'`，消费会话事件 | — | **type-only（remote projection）** | 纯事件投影定义 |
| `packages/preset/agent-presets/src/index.ts` | `agent.ctx`（`composedPreset(agent.ctx)`、`serviceFor(agent)`、`mount(agentCtx)`/`composeFrom`/`recompose` 的 scope 链操作）、`agent.id`、`agent/created` 监听 | 读 ctx scope 链 + **写 scope 绑定**（bindScopeParent/rebind） | **worker-local** | 预设组成系统：通过 `agent.ctx` 的 scope 链把 agent 挂到 standing composition |
| `packages/preset/agent-presets/src/authoring.ts` | 无 Agent（纯 fs：cp/rm/readFile/chmod） | — | **type-only** | 文件系统作者面 |
| `packages/preset/agent-presets/src/discovery.ts` | 无 Agent（纯 fs 扫描 + YAML 健康检查） | — | **type-only** | 发现层 |
| `packages/preset/agent-presets/src/invariant.ts` | `context.agent`（system-prompt/assemble 上下文）、`agent.ctx`（`composedPreset(agent.ctx)`）、`agent.id` | 只读校验 | **read-model-driven** | invariant 伴生只读 `agent.id`/`agent.ctx` scope 链做断言 |
| `packages/preset/agent-presets/src/metadata.ts` | 无 Agent（纯 fs + YAML） | — | **type-only** | 元数据读写 |
| `packages/preset/agent-presets/src/mount.ts` | `agentCtx.plugin(PresetTree, config)`（**把 preset 插件树挂进 agent.ctx**）、`serviceForAgent` 读 `agent.ctx` scope 链 | 读 + **ctx 挂载** | **worker-local** | 组合核心：直接向 agent 的 scope context 挂插件子树 |
| `packages/preset/agent-presets/src/session.ts` | 无 Agent（纯函数，入参是 `SessionHeader`+`SessionEvent[]`） | — | **type-only** | `resolveSessionPreset` 只消费 Session 类型 |
| `packages/examples/acp-demo/src/index.ts` | 无 Agent（纯 `ctx.plugin` 编排） | — | **type-only** | 组合示例 |
| `packages/examples/agent-spine-demo/src/index.ts` | 无 Agent（纯 `ctx.plugin` 编排 + config 转发） | — | **type-only** | 组合 spine |
| `packages/examples/agent-spine-demo/src/invariant.ts` | 无（空 installer） | — | **type-only** | 空 invariant |

## Summary

| 分类 | 文件数 | 文件 |
|---|---|---|
| **worker-local** | 5 | api/remotes/agent-lookup.ts、host/apiproxy/api-proxy.ts、bundle/headless/index.ts、preset/agent-presets/index.ts、preset/agent-presets/mount.ts |
| **command-driven** | 4 | acp/acp/index.ts、sdk/server/server.ts、extensions/cordis-host-runner/index.ts、extensions/tool-cordis/index.ts |
| **read-model-driven** | 3 | extensions/cordis-host-runner/inspect-registry.ts、extensions/tool-cordis/inspect.ts、preset/agent-presets/invariant.ts |
| **type-only** | 14 | api/remotes/index.ts、api/remotes/client/index.ts、host/apiproxy/index.ts、tool-cordis/api-catalog.ts、client/runtime/steering-history.ts、ui-conversation/inbox.ts、ui-trajectory/trajectory-message-definitions.ts、agent-presets/authoring.ts、discovery.ts、metadata.ts、session.ts、examples/acp-demo/index.ts、agent-spine-demo/index.ts、agent-spine-demo/invariant.ts |

## Items needing human decision

1. **`api/remotes/agent-lookup.ts`（worker-local 边界件）** — 职责是「session id → 进程内真实 Agent」，`typert.contexts.configureHost('agent', … => agent.ctx)` 把 live Context 交给整个 Host RPC 层——worker 化后必须变成远程投影工厂；同时调用 `ctx.agents.resume/create`（command-driven）并只读 `session.header`。定夺点：留在主进程做「远程 handle 解析器」还是整体随 worker 走。
2. **`tool-cordis/index.ts` 的 `exec.agent`** — 工具执行器注入真实同进程 Agent，本文件仅作 handle 转发。若工具执行面留主进程而 agent 移入 worker，`exec.agent` 变远程 handle，`requireAgent()` 契约与 runner 服务签名全要改；若工具执行面随 worker 走则无碍。需决策「工具执行世界」归属。
3. **`cordis-host-runner/inspect-registry.ts` 的 agent 透传** — 文件自身只读 `agent.id`，但把 live `agent` 原样塞进 provider 回调（`{ agent, signal }`），provider 可能触达 `agent.ctx`。需定夺是改成「worker 侧 provider 注册」还是「host 侧投影查询」。
4. **`host/apiproxy/index.ts` vs `api-proxy.ts` 的包内拆分** — index.ts 单独看 type-only，但它是 worker-local 服务的外壳。按文件粒度搬移必须连带整个 service 语义。
5. **agent-presets 包的自然切分** — `index.ts`/`mount.ts`（scope 绑定/挂载，worker-local）与 `authoring.ts`/`discovery.ts`/`metadata.ts`/`session.ts`（纯文件系统/纯函数，type-only）可干净分开：发现与作者面可留主进程，组合面随 worker。

**Conclusion**：真正必须进 worker 的核心面 = `api-proxy.ts`（session/inbox/ctx 三面全触）+ agent-presets 组合面 + headless（已是 worker 原型）；`agent-lookup.ts` 是唯一一个「当前返回真实实例、worker 化后必须转型为远程投影」的结构性边界件，建议列为 P0 首攻点。其余 Host 消费者（ACP、SDK、cordis-host-runner、tool-cordis）全部可通过 steer/inject/followup/cancel RPC 命令化改造，无需搬移。
