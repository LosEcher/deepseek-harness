# Agent Note: Reject taskless subagent starts before provider startup

Status: implemented

[English](2026-09-05-subagent-prompt-admission.md) | 中文

## Problem

共享的 subagent 服务会接受空 prompt，或只含空白文本的 prompt。因此提供方可以在没有模型可见任务的情况下创建子会话，失败会在提供方启动之后才出现，而不是在共同的准入点被拒绝。

## Decision

除非 prompt 至少包含一个非空白文本块，`SubagentRuntime` 会拒绝一次性启动和可继续启动。该检查在提供方启动或可继续子级创建之前运行，并返回 `SubagentError` 代码 `INVALID_PROMPT`。现有 prompt 块仍然有效；这条规则只拒绝缺少任务的请求。

## Alternatives considered

**在每个提供方里校验。** 否决，因为提供方会漂移，而且提供方可能在发现无效任务之前就发布子级。

**允许空 prompt 并依赖模型。** 否决，因为空会话不是有意义的委派运行，也不能产生可靠的任务证据。

**要求恰好一个文本块。** 否决，因为共享 prompt 类型有意支持有序的多模态块；这次改动只要求有可观察的文本任务。

## Consequences

无效的委派请求会在子级发布之前确定性地失败。提供方实现不需要重复准入检查，无效输入的提供方 start 次数保持为零。该检查不验证提供方特定的 prompt 能力；那些仍由提供方负责。

单元测试钉住空的和仅空白的一次性启动，以及在查找 continuation 服务之前就失败的无任务可继续启动。
