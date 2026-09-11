# Agent Note: DSH-to-LOS Grok runtime adapter

Status: implemented

English | [中文](2026-09-05-los-grok-runtime-adapter.zh.md)

## Problem

LOS can expose a runnable Grok external runtime, but the harness had no `ctx.subagents` provider that discovered that capability, invoked the operator API, or converted the SSE lifecycle into a DSH subagent result. Selecting Grok in LOS therefore did not prove that a DSH task could execute.

## Decision

`@deepseek-ai/dsh-subagent-los-grok` is an optional one-shot provider on `ctx.subagents`. Each accepted run probes `GET /runtimes/capabilities`, invokes `POST /runtimes/grok/run` only when Grok is `implementation: runnable` and `available: true`, parses bounded SSE output including a terminal frame at EOF without a blank-line delimiter, and maps cancellation, timeout, process failure, and missing terminal state to a non-success result.

The provider advertises `NO_START_CAPABILITIES` and `inheritsParentContext: false`. It reads the parent Session cwd as `workspaceRoot`, carries operator credentials only from named environment variables, and bounds captured output. LOS remains the source of truth for runtime availability and process evidence. DSH does not duplicate the LOS agent loop or claim resume semantics that the external-runtime protocol does not provide.

## Alternatives considered

**Configure only LOS `xai/grok-*`.** Rejected because that makes LOS's agent loop use Grok but does not make DSH delegate a subagent run.

**Spawn `grok` directly from DSH.** Rejected because it duplicates LOS lifecycle, authorization, capability discovery, and evidence rules.

**Treat HTTP success as task success.** Rejected because provider capacity, process exit, terminal event, and business verification are separate facts.

## Consequences

A Profile can install the optional Bundle and expose `los-grok` through a delegation tool row. Invalid or unavailable Grok capacity fails closed before `POST /runtimes/grok/run`. Callers give up continuation, resume, and parent-history seeding in exchange for a bounded external-runtime adapter that does not own LOS process evidence.

Unit tests inject `fetch` and pin capability-closed, completed SSE, pre-start abort, and published-run settlement paths. Live LOS capability and Grok task execution remain operator-owned because they need credentials and a reachable gateway.
