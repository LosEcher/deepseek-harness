# dsh-agent-control

[English](README.md) | 中文

进程安全的 Agent 控制 Service Definition（`ctx.agentControl`）。调用方持有 `AgentDescriptor` 记录并发出命名命令。它们永远不会得到活的 `Agent`；`session`、`inbox` 和 `ctx` 留在 worker 内。

活的 `Agent` 接口仍是 [`dsh-agent`](../agent/README.md) 所记录的 worker 进程内对象图。本包是 `local-ts` 与 `worker-ts` 所实现的命令、generation、背压和会话所有权约定。

## 服务：`AgentControl`（ctx key：`agentControl`）

抽象服务。每个上下文加载一个 provider（`dsh-agent-worker`）。

| 方法 | 职责 |
|---|---|
| `create` / `resume` | 启动一个 generation 并获取事件流所有权 |
| `send` / `followup` / `steer` / `inject` | JSON 可序列化的 inbox 命令 |
| `cancel` | 幂等中止 |
| `whenIdle` | 达到 drained 强度的静止 |
| `flush` / `drain` / `dispose` | 持久化与租约释放 |
| `onNotification` | 订阅读模型投影：已提交的 `session/event`、`agent/status` 与 `agent/drained` 通知（仅 JSON 可序列化值） |
| `get` / `list` / `roots` / `isOwnedBy` | 读模型查询 |

函数和 Cordis 上下文从不出现在载荷中。`runMaintenance` 没有 wire 形态。

## 读模型通知

只需要有界投影的主进程消费者（headless runner、未来的 Host/ACP 入口）用 `onNotification` 订阅。两个后端发出相同的词汇表：已提交的 `session/event` 通知携带 `{ agent, generation, seq, event }`；`agent/status` 镜像 idle/running；`agent/drained` 报告该 generation 的释放。worker 通知受接收方 credit 流控，supervisor 转发时补给。

## 会话所有权

写者身份是最后一条 `session/ownership` 事件（`acquire` / `release`）。另一个 generation 仍持有时，第二代不能获取。进程退出不是持久性证明；只有 `drain` 会为计划中的切换释放租约。

## Model Experience

本服务不组装模型请求；worker 进程内的 Agent 拥有一切模型可见事实。

#### KV Cache effect

无直接失效；worker 进程内组合拥有任何请求前缀变化。

## Known Limitations and Deferred Work

- **已交付 profile 仍走活的 `Agent` 注册表** — Host、ACP 仍针对 `ctx.agents` 编程，直到这些入口被远程化到本服务（headless 一次性入口已改走 `agentControl`）。
- **组装后的产品快照仍在进程内运行** — worker-ts 默认只启动主干加上夹具适配器；设置 provider 的 `workerProfile` 可挂载完整组合 profile。
