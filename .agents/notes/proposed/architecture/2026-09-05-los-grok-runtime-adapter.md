# Agent Note: DSH-to-LOS Grok runtime adapter

## Problem

LOS can expose a runnable Grok external runtime, but DSH previously had no provider that discovered that capability, invoked the operator API, or converted the SSE lifecycle into a DSH subagent result. Selecting Grok in LOS therefore did not prove that a DSH task could execute.

## Decision

Add `@deepseek-ai/dsh-subagent-los-grok` as an optional `ctx.subagents` provider. The provider performs capability discovery before dispatch, validates the parent workspace, invokes the shared LOS runtime endpoint, parses bounded SSE output, flushes a terminal frame that arrives at EOF without a blank-line delimiter, and maps cancellation, timeout, process failure, and missing terminal state to non-success results.

LOS remains the source of truth for runtime availability and process evidence. DSH does not duplicate the LOS agent loop or claim resume semantics that the external-runtime protocol does not provide.

## Alternatives considered

- Configure only LOS `xai/grok-*`: rejected because that makes LOS's agent loop use Grok but does not make DSH delegate a subagent run.
- Spawn `grok` directly from DSH: rejected because it duplicates LOS lifecycle, authorization, capability discovery, and evidence rules.
- Treat HTTP success as task success: rejected because provider capacity, process exit, terminal event, and business verification are separate facts.

## Verification

- `pnpm --filter @deepseek-ai/dsh-subagent-los-grok exec tsc --noEmit -p tsconfig.json` — passed.
- `pnpm exec vitest run packages/subagent/subagent-los-grok/tests/los-grok.spec.ts --config vitest.config.ts` — 2/2 passed.
- Live LOS capability and Grok task execution were not run in this change because operator credentials and current service state were not injected into the test process.

## Follow-up

Mount the optional bundle in the intended DSH profile, run a real read-only golden task through the adapter, and only then add a durable resume contract if the LOS protocol exposes one.
