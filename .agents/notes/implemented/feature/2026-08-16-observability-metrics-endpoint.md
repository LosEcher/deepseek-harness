# Agent Note: Observability P1 — session-ledger /metrics endpoint

Status: implemented

English | [中文](2026-08-16-observability-metrics-endpoint.zh.md)

Date: 2026-08-16

## Problem

The observability borrow list (`.agents/notes/proposed/architecture/2026-08-16-observability-borrow-from-los.md`) item P1: a Prometheus `/metrics` endpoint over session-ledger aggregates, which also closes the known `turn/pending` visibility gap (the marker has no UI or metric surface). Default-off until a deployment states a requirement (telemetry policy).

## Decision

A new bundle, `@deepseek-ai/dsh-observability` (`packages/bundle/observability`), whose patch inserts one plugin row (`id: observability`) that injects `sessions` + `webServer` and registers an exact `/metrics` route in Prometheus text format 0.0.4. All series are derived projections of the event stream and the live session set — no new instrumentation, no persistence, no runtime behavior change. It is default-off by composition: only profiles that include the bundle mount it (web profiles; headless must not, per the webServer-dependency rule).

Series:

- `dsh_active_sessions{preset}` gauge — live sessions by `agentPreset` (`unset` when absent).
- `dsh_turn_pending` gauge — sessions parked on a `turn/pending` tail. Seed history replays into the turn cursor only (seed events never re-publish as `session/event`); process-scoped counters are since-process-start by design.
- `dsh_compaction_total`, `dsh_events_total{type}` counters.
- `dsh_llm_calls_total{provider,model,reasoning_effort}` from `request/header` events.
- `dsh_llm_tokens_total{kind,model,provider}` from `assistant/message` usage — the byProviderModel usage-cube projection (cost stays a deployment concern: it needs provider price tables, not event data).
- `dsh_tool_calls_total{tool}`.

The `MetricsRegistry` is a pure, dependency-free class (unit-tested); the plugin is a thin wiring layer. The integration test mounts the real web server on port 0 and fetches `/metrics`.

## Alternatives considered

**Fold metrics into the base bundle.** Rejected: base is the shared core of every profile; the borrow list is default-off until a deployment asks, and headless must not load a webServer-dependent plugin. A separate bundle keeps the decision compositional.

**Persist a metrics projection (token-meter shape).** Rejected: process-scoped counters rebuilt from events on restart are the deliberate semantics here; the durable read model is the event log itself.


## GUI surface (added same day)

The bundle also ships a client half (`dsh.client` declaration, `exports["./client"]`,
esbuild bundle with inlined css-modules, jsx automatic — the standard DSH client
build template) registering a `conversation.view` tab '观测'. It polls the new
structured `/observability/summary` JSON endpoint (same fold as `/metrics`) every
5s and renders summary cards plus per-preset / per-route / per-tool / per-event
distributions, theme-aware via design tokens only. The client face is
type-checked (tsconfig jsx/DOM + react devDeps), so the strict-TS and lint gates
cover it.

## Consequences

Profiles that include `@deepseek-ai/dsh-observability` expose `GET /metrics` on the web server with the series above; nothing else changes. The `turn/pending` gap is closed for metrics consumers (GUI presentation remains a separate gap). Items P2–P3 of the borrow list are unchanged.
