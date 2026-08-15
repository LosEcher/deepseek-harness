# dsh-agent-worker

[English](README.md) | 中文

[`dsh-agent-control`](../agent-control/README.md) 的 `local-ts` 与 `worker-ts` provider。后端选择是插件加载时解析的显式 Config 字段，并作为 `backend` 报告；它绝不是隐式回退。

`local-ts` 包装进程内的 `ctx.agents` 注册表。`worker-ts` 为每个 Agent 生成一个 Node 子进程，在 stdio 上使用产品 bridge，并把活的 `Agent` 留在该子进程内。

## Config

| 键 | 默认值 | 说明 |
|---|---|---|
| `backend` | `'local-ts'` | `'local-ts'` 或 `'worker-ts'` |
| `commandQueueLimit` | `32` | 队列满时以 `busy` 拒绝 |
| `eventCredit` | `64` | 未确认的 `session-event` 额度 |
| `replayWindow` | `1024` | resume 回放上限；`0` 会被拒绝 |
| `sessionRoot` | 未设置 | worker 为 drain-and-resume 挂载的 JSONL 根目录 |

`local-ts` 在加载时需要 `ctx.agents` 和 `ctx.sessions`。`worker-ts` 不需要。

## 隔离

杀死一个 worker 进程不能终止主进程或另一个 Agent。监督器将该 generation 标为 `faulted`。resume 是 drain 之后、或监督器观察到子进程退出之后的新 generation。

## Model Experience

本 provider 不组装模型请求；worker 进程内的 Agent 组合拥有一切模型可见事实。

#### KV Cache effect

无直接失效；worker 进程内组合拥有任何请求前缀变化。

## Known Limitations and Deferred Work

- **已交付 profile 仍默认使用进程内 `ctx.agents`** — 本插件是显式接入，不改变 `web` 或 `headless`。
- **worker-ts 启动主干加上夹具适配器** — 不是已交付的产品组合。组装快照仍走 `local-ts`，直到 worker 挂载与这些快照相同的插件。
- **Host、ACP 和 SDK 入口尚未远程化** — 它们仍在主进程持有活的 `Agent` 对象。
