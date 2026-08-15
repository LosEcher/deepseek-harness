# Agent Note: Pending-turn resume and loop-level drain gate

Status: implemented

English | [中文](2026-08-15-pending-turn-resume-and-drain-gate.zh.md)

## Problem

Fast shutdown writes `turn/pending` and crash repair leaves that turn open, but resume treated the log like a closed history: the next `turn/start` failed the session invariant (`turn/start` while the previous turn is still open). A planned restart also waited for every live phase, including model wait that the phase-aware drain already treats as safe to leave open. `markDraining` only armed machines that already existed, so a session created after the restart request could start a new turn.

## Decision

Resume continues an open `turn/pending` tail on the same turn. `resumablePendingTurn()` walks the log; the driver closes any open step, opens the next step, and re-issues the model request from `deriveMessages()`. Orphan `assistant/chunk` events stay in the log and are not model-visible, so the retry does not need chunk-level dedup. Publication auto-starts that continuation.

`markDraining()` is loop-level: the flag is stored on `AgentLoop` and inherited by every machine created after the call.

The restart coordinator waits only for `hasBlockingActivity()` (tool in flight). Model wait and pre-step do not block; `interrupt(0)` takes the existing `shutdownDrain` path, which marks them `turn/pending` and flushes. The wait cap still forces that path if a tool does not settle.

A rejected `session/flush` during `shutdownDrain` and a refused `turn/pending` append are logged; they do not throw out of the drain.

## Alternatives considered

**Close the pending turn with a new `TurnEndReason` such as `suspended`.** Rejected for the shipped path: it would abandon the open-tail contract `turn/pending` already documents and force every resume to start a new turn. Keep that option only if resume cannot continue the same turn.

**Wait for every live phase before a planned restart.** Rejected: it re-introduces the fixed-wait drain the [event-sourced turn switching](../../proposed/architecture/2026-08-14-event-sourced-turn-switching.md) note discarded, and it waits for model streams that have no external side effects.

**Per-machine draining only.** Rejected: a session or subagent created after the request would reopen work and prevent the wait from converging.

## Consequences

Opening or resuming a session whose log ends in `turn/pending` immediately continues that turn (one extra model request). A planned restart no longer waits out a long model stream; the stream is left as a pending tail and continued after the new process publishes the agent.

Flush failure still means the next boot may treat the tail as a crash. The drain log names that failure; it is not a silent success.

## Testing

- `packages/core/session/tests/repair.spec.ts` pins `resumablePendingTurn` for open-step, closed-step, crash, and already-closed tails.
- `packages/core/session/tests/invariant.spec.ts` rejects `turn/pending` that does not name the open turn.
- `packages/core/agent-loop/tests/drain.spec.ts` covers loop-level inherit, `hasBlockingActivity`, flush-failure logging, seed continue with no open step, and a refused pending marker.
- `packages/core/agent-loop/tests/resume.spec.ts` persists a hung model-wait drain and resumes the same turn through a new process.
- `apps/cli/tests/restart-coordinator.spec.ts` waits only on `hasBlockingActivity`.

## Named coverage gaps

Assembled keyless snapshots do not yet replay a `turn/pending` resume through a headless or ACP example. The persist+resume package test is the current proof.
