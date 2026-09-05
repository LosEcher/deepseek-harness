# Agent Note: Reject taskless subagent starts before provider startup

Status: implemented

English | [中文](2026-09-05-subagent-prompt-admission.zh.md)

## Problem

The shared subagent service accepted an empty prompt or a prompt containing only whitespace text. A provider could therefore create a child session without a model-visible task, and the failure surfaced after provider startup instead of at the common admission point.

## Decision

`SubagentRuntime` rejects one-shot and continuable starts unless the prompt contains at least one non-whitespace text block. The guard runs before provider startup or continuable-child creation, and returns `SubagentError` code `INVALID_PROMPT`. Existing prompt blocks remain valid; the rule only rejects a missing task.

## Alternatives considered

**Validate in each provider.** Rejected because providers would drift and a provider could publish a child before discovering the invalid task.

**Allow empty prompts and rely on the model.** Rejected because an empty session is not a meaningful delegated run and cannot produce reliable task evidence.

**Require exactly one text block.** Rejected because the shared prompt type intentionally supports ordered multimodal blocks; this change only requires an observable text task.

## Consequences

Invalid delegated requests fail deterministically before child publication. Provider implementations do not need duplicate admission checks, and the provider start count remains zero for invalid input. The guard does not validate provider-specific prompt capabilities; those remain provider responsibilities.

## Verification

- `pnpm exec vitest run packages/subagent/subagent/tests/service.spec.ts --config vitest.config.ts`
- `pnpm --filter @deepseek-ai/dsh-subagent exec tsc --noEmit -p tsconfig.json`
