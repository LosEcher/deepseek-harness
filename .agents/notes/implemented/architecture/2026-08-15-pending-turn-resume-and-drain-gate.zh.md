# Agent Note: Pending 回合续跑与 loop 级 drain 门闩

Status: implemented

[English](2026-08-15-pending-turn-resume-and-drain-gate.md) | 中文

## Problem

快速关闭会写入 `turn/pending`，崩溃修复也会保持该回合打开，但恢复仍把日志当成已闭合历史：下一次 `turn/start` 会触发会话不变量失败（上一回合仍打开时又开新回合）。计划内重启还会等待每一个活阶段，包括阶段感知 drain 已视为可安全留洞的模型等待。`markDraining` 只武装当时已有的 machine，重启请求之后新建的会话仍能开新回合。

## Decision

恢复会在同一回合续跑未闭合的 `turn/pending` 尾。`resumablePendingTurn()` 扫描日志；驱动器闭合任何未结束的 step，打开下一 step，并从 `deriveMessages()` 重发模型请求。孤儿 `assistant/chunk` 留在日志里、不进入模型可见历史，因此这次重试不需要分片级去重。发布后自动开始这次续跑。

`markDraining()` 是 loop 级门闩：标志存在 `AgentLoop` 上，之后创建的每个 machine 都会继承。

重启协调器只等待 `hasBlockingActivity()`（工具在途）。模型等待和 pre-step 不阻塞；`interrupt(0)` 走现有 `shutdownDrain`，将它们标为 `turn/pending` 并 flush。若工具未在上限内结束，等待上限仍会强制走该路径。

`shutdownDrain` 期间被拒绝的 `session/flush`，以及未能写入的 `turn/pending`，都会记日志，但不会从 drain 向外抛出。

## Alternatives considered

**用新的 `TurnEndReason`（例如 `suspended`）闭合 pending 回合。** 作为已交付路径被拒绝：这会放弃 `turn/pending` 已经写明的开尾约定，并迫使每次恢复都开新回合。只有在无法续跑同一回合时才保留该选项。

**计划内重启等待每一个活阶段。** 被拒绝：这会把[事件溯源回合切换](../../proposed/architecture/2026-08-14-event-sourced-turn-switching.md)已经否掉的固定等待重新引入，并让没有外部副作用的模型流拖住重启。

**只按 machine 武装 draining。** 被拒绝：请求之后新建的会话或子代理会重新开工，等待无法收敛。

## Consequences

打开或恢复一条以 `turn/pending` 结尾的会话会立即续跑该回合（多一次模型请求）。计划内重启不再等完长模型流；该流作为 pending 尾留下，并在新进程发布 agent 后续跑。

flush 失败仍可能让下次启动把尾当成崩溃。drain 日志会点名这次失败，而不是静默成功。

## Testing

- `packages/core/session/tests/repair.spec.ts` 固定 `resumablePendingTurn` 对开着的 step、已闭合 step、崩溃尾和已关闭回合的结果。
- `packages/core/session/tests/invariant.spec.ts` 拒绝 `data.turn` 与当前打开回合不符的 `turn/pending`。
- `packages/core/agent-loop/tests/drain.spec.ts` 覆盖 loop 级继承、`hasBlockingActivity`、flush 失败日志、无开着 step 的 seed 续跑，以及被拒绝的 pending 标记。
- `packages/core/agent-loop/tests/resume.spec.ts` 把挂起的模型等待 drain 落盘，并在新进程里续跑同一回合。
- `apps/cli/tests/restart-coordinator.spec.ts` 只按 `hasBlockingActivity` 等待。

## Named coverage gaps

组装后的无密钥快照尚未通过 headless 或 ACP 示例重放 `turn/pending` 恢复。当前证明是带持久化的包级恢复测试。
