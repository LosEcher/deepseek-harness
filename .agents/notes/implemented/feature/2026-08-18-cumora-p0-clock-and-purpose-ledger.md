# Agent Note: Cumora P0 — per-turn UTC clock and per-purpose LLM usage ledger

Status: implemented

Date: 2026-08-18

## Problem

Two P0 requirements from the Cumora analysis (dsfolder/CUMORA-REQUIREMENTS-DSH-2026-08-18.md):

1. **R-DSH-02 — turn context carries the current time.** Cumora's real-world lesson:
   a model that does not know the current time silently lands deadline arithmetic
   (calendar --at, scheduled tasks) in the past. Acceptance: every turn's system
   prompt/context contains a UTC ISO timestamp, unit-tested present and fresh (≤60s).
2. **R-DSH-01 — per-purpose LLM cost ledger + aggregation projection.** Acceptance:
   a new endpoint or aggregation query returns tokens/cost/calls keyed by
   (provider, model, purpose).

## Decisions

### Clock injection (R-DSH-02) — system-prompt section, not runtime context

The clock lives as a **system-prompt section** (`runtime:clock`, order 10, after the
persona) rather than a runtime-context contribution. Reasons:

- A runtime-context contribution would change the rendered snapshot text every
  minute, re-emitting a full snapshot user message per turn (the projection only
  suppresses unchanged text), wasting tokens and churning session history.
- A section is re-evaluated per assembly but only changes the request `system`
  text. `headerEquals` compares `system`, so minute precision keeps the header
  stable within a minute and avoids per-turn `request/header` re-logs.
- Freshness contract: minute precision means a model-visible time is at most 60s
  stale, exactly the acceptance bound.

New `Config.includeClock` (default true) lets a compatibility deployment that pins
its own complete prompt opt out (mirrors `includeHarnessIdentity`); agent-spine-demo
forwards it.

### Purpose ledger (R-DSH-01) — usage cube in dsh-observability

The `MetricsRegistry` gains a per-(provider, model, purpose) usage cube folded from
three event sources:

| Purpose | Source event | Fields |
|---|---|---|
| `assistant` | `request/header` + `assistant/message` | calls from header, tokens from message usage |
| `compaction` | `compaction/summary` | calls + usage carried on the summary event |
| `session-title` | `session/title-llm-request` | calls only (event records route, not usage) |

`/observability/summary` gains a `usage` array `{provider, model, purpose, calls,
inputTokens, outputTokens, cost?}`; `/metrics` series are unchanged (backward
compatible). Cost estimation is optional via a price table in the plugin config
(`prices`, USD per 1M tokens keyed by `provider/model`); without it, `cost` is
omitted — cost stays a deployment concern, consistent with the borrow list.

The two plugin-extended events (`compaction/summary`, `session/title-llm-request`)
are typed locally in the bundle to avoid hard dependencies on dsh-compaction /
dsh-session-title-llm.

## Alternatives considered

**Clock as runtime context.** Rejected: snapshot re-emission per minute wastes
tokens and turns history churn; the projection's change-suppression is defeated by
any per-turn-varying contribution.

**Clock at second precision.** Rejected: the request header would change per turn,
re-logging `request/header` events continuously.

**Cost in the event stream.** Rejected: prices are deployment data, not event data
(the borrow list's P2 usage/cost cube already defers cost to a price table).

## Consequences

- Every request's system prompt now carries `Current time (UTC ISO-8601): <minute-precision ISO>`.
- `/observability/summary` reports per-purpose usage; the GUI tab consumes the
  structured endpoint and is unaffected by the new field.
- Sessions' `request/header` events now log `system` text containing a timestamp;
  `headerEquals` already folds `system`, and minute precision bounds re-logging.
- No persistence or event-taxonomy change; everything is a derived projection.

## Verification

- `packages/core/system-prompt` — new test asserts the clock section exists and is
  fresh (≤60s); snapshot order tests updated.
- `packages/bundle/observability` — new tests fold all three purposes and estimate
  cost only when a price table is configured.
- Full suite: 13549 passing; the 5 remaining failures are pre-existing baseline
  (ci-workflow, rust-migration-ledger, typert catalog x3).
- `npm run typecheck` and `npm run lint` pass at baseline counts.
