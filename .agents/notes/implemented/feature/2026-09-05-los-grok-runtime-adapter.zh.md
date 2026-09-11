# Agent Note: DSH-to-LOS Grok runtime adapter

Status: implemented

[English](2026-09-05-los-grok-runtime-adapter.md) | 中文

## Problem

LOS 可以暴露可运行的 Grok 外部运行时，但 harness 没有对应的 `ctx.subagents` 提供方去发现该能力、调用 operator API，或把 SSE 生命周期转换成 DSH subagent 结果。因此在 LOS 中选择 Grok，并不能证明 DSH 任务能够执行。

## Decision

`@deepseek-ai/dsh-subagent-los-grok` 是 `ctx.subagents` 上的可选一次性提供方。每次被接受的运行会探测 `GET /runtimes/capabilities`，仅在 Grok 为 `implementation: runnable` 且 `available: true` 时调用 `POST /runtimes/grok/run`，解析有界 SSE 输出（包括 EOF 处没有空行分隔的 terminal frame），并把取消、超时、进程失败和缺少 terminal 状态映射为非成功结果。

该提供方声明 `NO_START_CAPABILITIES` 且 `inheritsParentContext: false`。它把父会话 cwd 作为 `workspaceRoot`，只从命名环境变量携带 operator 凭据，并限制捕获输出。runtime 可用性与进程证据仍以 LOS 为准。DSH 不复制 LOS agent loop，也不声称外部运行时协议并未提供的 resume 语义。

## Alternatives considered

**只配置 LOS `xai/grok-*`。** 否决，因为那只让 LOS 的 agent loop 使用 Grok，并不能让 DSH 委派一次 subagent 运行。

**从 DSH 直接 spawn `grok`。** 否决，因为它会复制 LOS 的生命周期、授权、能力发现和证据规则。

**把 HTTP 成功当成任务成功。** 否决，因为提供方容量、进程退出、terminal event 和业务验证是分开的事实。

## Consequences

Profile 可以安装这个可选 Bundle，并通过委派工具行暴露 `los-grok`。无效或不可用的 Grok 容量会在 `POST /runtimes/grok/run` 之前 fail closed。调用方放弃 continuation、resume 和父级历史播种，以换取一个有界的外部运行时适配器，且该适配器不拥有 LOS 进程证据。

单元测试注入 `fetch`，钉住能力关闭、完成的 SSE、启动前取消以及已发布 run 的结算路径。真实 LOS 能力与 Grok 任务执行仍由 operator 负责，因为它们需要凭据和可达网关。
