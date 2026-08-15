# Agent Note: Agent 控制 Service Definition 与 Node worker 监督器（P1）

Status: implemented

[English](2026-08-15-agent-control-p1.md) | 中文

## Problem

活的 `Agent` 接口不能跨越进程边界。P0 定义了进程安全的控制协议、bridge 映射、事件流所有权和消费方分类，但 TypeScript Service Definition 和监督器还不存在，因此无法声称 Agent 隔离。

## Decision

P1 交付三个包，并确认 P0 的租约与放置决策。

`@deepseek-ai/dsh-bridge-protocol` 是产品 bridge 消息、Content-Length framing 和握手配对的 TypeScript 语义所有者。`node_root` 除与 `rust_sidecar` 配对外，也与 `node_worker` 配对。

`@deepseek-ai/dsh-agent-control` 是 Service Definition（`ctx.agentControl`）。调用方持有 `AgentDescriptor` 记录并发出命名命令。活的 `Agent` 留在 worker 进程内。

`@deepseek-ai/dsh-agent-worker` 是 provider。`backend` 是显式 Config 字段，默认为 `local-ts`。`local-ts` 包装 `ctx.agents`。`worker-ts` 为每个 Agent 生成一个 Node 子进程，并在 stdio 上使用 bridge。

会话写者身份是最后一条 `session/ownership` 事件（P0 候选 B）。另一个 generation 仍持有时，第二代不能获取。`drain` 是 idle + flush + 释放；进程退出不是持久性证明。

P0 的十二项边界件保持建议放置：agent-lookup 转型为远程投影工厂；tools scope 按 `sessionId` 重键；工具执行世界随 worker；subagent 整体留在 worker；在更多入口远程化之前，WeakMap 键改到 `sessionId`。

已交付的 `web` 和 `headless` profile 仍针对 `ctx.agents` 编程。worker-ts 启动主干加上夹具适配器。组装后的产品快照仍走进程内路径，直到 worker 挂载同一组合。

## Alternatives considered

**返回一个类型为 `Agent` 的远程对象。** 已在隔离提案中拒绝；P1 不再重开。

**用外部租约文件作为 worker 协议租约。** 作为 P0 候选 A 拒绝：它增加第三套单写者机制，并且仍需要陈旧性证明。磁盘文件仍是 P3 叶子原语，不是本协议的租约。

**在同一步把已交付 profile 改成 `worker-ts`。** 拒绝：worker 组合是主干，不是产品 profile。先用一致性与崩溃测试证明隔离。

**把协议类型只放在 `dsh-agent-worker` 内。** 拒绝：Rust 门面和 Agent worker 共用一套 IPC 原语。

## Consequences

仍读取 `agent.session`、`agent.inbox` 或 `agent.ctx` 的主进程插件，在这些插件搬走或远程化之前，仍是隐式远程对象风险。[P0 笔记](../../proposed/architecture/2026-08-15-agent-control-protocol-p0.md) 中的分类表是放置图。

`session/ownership` 在读取时是必需的。不理解它的写者必须拒绝该日志。

每个 Agent 的进程成本尚未测量。池化仍不在范围内。

## Required verification

- `packages/core/agent-control/tests/agent-control.spec.ts` 接受正向 fixture 语料，并以记录的短语拒绝负向语料；所有权拒绝第二获取者。
- `packages/core/agent-control/tests/invariant.spec.ts` 拒绝第二次 acquire 以及没有 acquire 的 release。
- `packages/core/agent-worker/tests/agent-worker.spec.ts` 覆盖 local-ts 的 create/followup/drain、带 JSONL 的 local-ts drain-and-resume、SIGKILL 后 worker-ts 兄弟存活，以及 worker-ts drain-and-resume。
- `packages/util/bridge-protocol/tests/bridge-protocol.spec.ts` 覆盖 framing、含 `node_worker` 的握手配对，以及优先帧。

## Named coverage gaps

- 组装后的无密钥快照尚未通过 `worker-ts` 运行。
- Host、ACP 和 SDK 入口仍持有活的 `Agent` 对象。
- 繁忙 session-event 流下的接收方额度耗尽在准入层有单元覆盖，尚未作为长时 worker 做压力测试。
