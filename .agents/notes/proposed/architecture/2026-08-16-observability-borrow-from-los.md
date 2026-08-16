# Agent Note: Observability borrow list from los (comparison review)

Status: proposed

> Update 2026-08-16: item 1 (P1 `/metrics`) implemented as the
> `@deepseek-ai/dsh-observability` bundle (see
> `.agents/notes/implemented/feature/2026-08-16-observability-metrics-endpoint.md`),
> including the `turn/pending` metric surface. Items 2–5 unchanged.

English | [中文](2026-08-16-observability-borrow-from-los.zh.md)

Date: 2026-08-16

## Problem

A systematic comparison of DSH vs los observability (report: los repo `docs/research/2026-08-16-observability-comparison-dsh.md`) confirmed DSH's event-sourced session log is a strong base — replay, audit, and statistics are structurally free (append-only log + derived projections), and the telemetry seam (redact waterfall, handoff cursor, FULL/FEEDBACK_ONLY/DISABLED modes, sharing disclosure) is ahead of los. But the comparison also surfaced five capabilities los has that DSH lacks. This note records the borrow list so the gaps are explicit and can be picked up when a deployment states a requirement.

## Gaps (los capabilities DSH lacks)

1. **Prometheus metrics endpoint.** los exposes `GET /metrics` in Prometheus text format, all samples aggregated from PostgreSQL evidence (survives restart). DSH has no `/metrics` endpoint and no process-level gauges. For DSH, a natural source is the session ledger itself: active sessions, event throughput, `turn/pending` counts (which currently have no UI or metric surface at all), compaction counts.
2. **Quality evaluation framework.** los persists `run_evals` (success/latency/tool errors/verification status/model cost/failure class, pairwise A/B with baseline/candidate run spec ids, rubric revisions) and `daily_agent_quality_snapshots` (idempotent per-tenant/project/date snapshots of inbox/schedule/recovery/verification/provider quality). DSH has eval test infra but no durable quality evidence table.
3. **Usage/cost cube.** los `GET /usage/summary` aggregates token/cost/cache-hit evidence by provider/model/day with an evidence-class contract (L1 los_runtime authoritative, L2 wire_inspect reserved, L3 external CLI fleet overview only). DSH has token projections but no cost cube.
4. **External agent telemetry ingestion.** los runs a local OTLP/HTTP bridge (4318) that maps external agent CLI spans (Claude Code / Codex) into its session event ledger. DSH's hooks-claude-code / hooks-codex are behavior hooks, not telemetry ingestion.
5. **Daily trend read model.** los `daily_agent_quality_snapshots` is a point-in-time read model with a `collecting`/`complete` evidence window (28-day). DSH has projection machinery (`session-projection`) but no date-idempotent snapshot semantics.

## Suggested priorities (when picked up)

- P1: `/metrics` endpoint over session-ledger aggregates (also gives `turn/pending` visibility — the known GUI gap).
- P2: durable quality evidence table (align with eval package when a deployment asks for longitudinal quality).
- P2: usage/cost cube (requires cost metadata in the event stream or provider usage normalization).
- P3: external-agent OTel ingestion (only if the harness starts wrapping external CLIs as first-class runtimes).
- P3: date-idempotent snapshots (projection machinery exists; the snapshot semantics are the new part).

## Alternatives considered

**Fold all five into one "observability package".** Rejected: metrics, quality evidence, cost, ingestion, and snapshots have different consumers and maturity levels; the borrow list stays a list until a deployment states a requirement, matching the repo's telemetry policy of default-off until explicitly needed.

**Adopt los's PostgreSQL ledger instead of the JSONL event log.** Rejected: DSH's event-sourced log already provides replay/audit structurally, and the file-based append-only format is a deliberate decision (see session-persistence notes); the borrow list is additive, not a substrate change.

## Consequences

The five gaps remain documented, prioritized, and decoupled from any single feature. Implementing item 1 (metrics endpoint) would incidentally close the `turn/pending` visibility gap. Nothing in this note changes current runtime behavior.
