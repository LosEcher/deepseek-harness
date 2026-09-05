# Agent Note: 在 provider 启动前拒绝无任务的 subagent 启动

Status: implemented

[English](2026-09-05-subagent-prompt-admission.md) | 中文

## Problem

共享 subagent service 以前会接受空 prompt 或只包含空白文本的 prompt。因此 provider 可能创建一个没有面向模型任务的 child session，且失败会在 provider 启动后才暴露，而不是在公共准入点暴露。

## Decision

`SubagentRuntime` 要求一次性启动和可继续启动的 prompt 至少包含一个非空白文本 block，否则拒绝请求。守卫在 provider 启动或可继续 child 创建前执行，并返回错误码为 `INVALID_PROMPT` 的 `SubagentError`。既有 prompt block 仍然有效；该规则只拒绝缺失任务。

## Alternatives considered

**在每个 provider 中分别校验。** 放弃，因为各 provider 会发生漂移，而且 provider 可能在发现无效任务前已经发布 child。

**接受空 prompt，交给模型自行处理。** 放弃，因为空 session 不是有意义的委派运行，也不能产生可靠的任务证据。

**要求恰好一个文本 block。** 放弃，因为共享 prompt 类型有意支持有序多模态 block；本次变更只要求存在可观察的文本任务。

## Consequences

无效委派请求会在 child 发布前确定性失败。provider 实现不再需要重复准入检查，且无效输入的 provider 启动计数保持为零。该守卫不校验 provider 特有的 prompt 能力，这些仍由 provider 负责。

## Verification

- `pnpm exec vitest run packages/subagent/subagent/tests/service.spec.ts --config vitest.config.ts`
- `pnpm --filter @deepseek-ai/dsh-subagent exec tsc --noEmit -p tsconfig.json`
