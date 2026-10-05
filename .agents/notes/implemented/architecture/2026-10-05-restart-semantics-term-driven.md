# Agent Note: Restart is TERM-driven; the restart coordinator is not on this line

Status: implemented

English | [中文](2026-10-05-restart-semantics-term-driven.zh.md)

## Problem

A supervised deployment restarted `dsh web` by writing `$DSH_HOME/restart-request` and then waiting for the host to exit by itself. On this line nothing ever consumed that file, so every request fell through to the supervisor's 600-second backstop and killed the host with SIGTERM. The production log shows the wait in full, three times in two days, and once mid-session:

```
10-03 21:44:58 AUTO-RELOAD: restart-request; restart request published, awaiting host drain
10-03 21:54:58 coordinated exit timeout (600s); forcing TERM
10-05 09:29:52 AUTO-RELOAD: profile-plugin-manifest; ... awaiting host drain
10-05 09:39:52 coordinated exit timeout (600s); forcing TERM
10-05 11:11:46 AUTO-RELOAD: profile-plugin-manifest; ... awaiting host drain
10-05 11:21:48 coordinated exit timeout (600s); forcing TERM
10-05 22:42:20 AUTO-RELOAD: restart-request; (merged) ... awaiting host drain
10-05 22:52:25 child exited rc=143 reason=process-exit
```

The cause is a lineage split, not a regression. The coordinated restart was built on the fork's rc.8 lineage (`master` = `fork/master`): `apps/cli/src/restart-coordinator.ts`, the agent-loop drain gates (`markDraining`, `hasBlockingActivity`, `abortBlockingActivity`, `clearDraining`), the phase-aware fast-exit drain, and their companions — commits `c383e7f9`, `19d170f7`, `474fd247`, `60fae479`, `2dbd9562af`, `35c356e194`, `a3814690ac`, `86380cb016`, `3f6858658e`, `f9304445b4`, `97ff8c0500`. This line derives from upstream `0.1.5-rc.2` and contains none of them: `restart-coordinator.ts` is absent, no source file reads `restart-request`, and `turn/pending` is not an event type here. Only stale, gitignored build output still named the coordinator, so a reader searching the tree found the declaration without the code.

The declarations outlived the mechanism in five more places: the supervisor's header comment and its `COORDINATED_EXIT_TIMEOUT`, the restart script's header and its "the host coordinator consumes this file too" note, `dsplugins/dsh-restart-banner` (README, bundle patch, and a host half that wrote a signal nobody consumed), the leftover `$DSH_HOME/restart-exited` trace, and the orphan `lib/types/restart-coordinator.*` / `lib/types/resume-context.*` artifacts.

## Decision

Restart on this line is the signal semantics already owned by [Bounded, escalating signal shutdown for Web and headless](../bug-fix/2026-08-03-cli-signal-shutdown-escalation.md): `process.on('SIGTERM', () => { interrupt(0) })` in `apps/cli/src/profile-boot.ts`, then `signalShutdown.abort()`, `createProcessShutdown` disposal of the Cordis tree, and exit 0 with `PROCESS_SHUTDOWN_TIMEOUT_MS = 5000` as the force-exit backstop; SIGINT reports 130. Durability comes from the persistence provider's own teardown effect, which closes every open write handle and drains its buffer (`packages/session/session-persistence-jsonl/src/storage.ts`), not from a coordinator.

The supervisor therefore drives restarts itself: it consumes `restart-request`, TERMs the process that owns `:3080`, and treats a wrapper exit of `143` as the ordinary shape of a supervisor-driven stop rather than a failed restart. A bounded grace (20s here, against the host's 5s budget) escalates to the wrapper and reclaims the port. `restart-request` stays a public trigger file for scripts and agents; it is never a coordination handshake again, and no component may wait for a host self-exit.

In-flight model output and tool calls are not awaited. An unclosed turn is not marked `turn/pending` — that event does not exist on this line — so crash-repair synthesizes `interrupted` on the next boot (`packages/core/session/src/repair.ts`, `interruptedTurnClosers`). Accepting that loss is what buys the bounded window, and it is already the de-facto behavior: the backstop above produced `rc=143` restarts for both days.

The Rust migration inherits the mechanism rather than this implementation. Drain, turn-boundary exit, and resume belong to **P5** (model-visible trunk); the supervisor and its restart protocol belong to **P8** (web host native supervisor). The TypeScript Step 1/2 work on the `master` lineage stays the **behavior oracle** for P5 fixtures and consistency tests — the same role the fork's P0–P9 plan (`.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md`, present only on that lineage) assigns it — and this note records that the oracle is not production code on this line.

## Alternatives considered

**Re-port the coordinator and the drain onto this line.** Rejected on measured cost against a scheduled replacement. The eleven commits total roughly 1,765 insertions across `apps/cli`, the agent loop, session, core tools, the host apiproxy, and client UI; the port targets are exactly the files upstream rewrote — `packages/core/agent-loop/src/agent.ts` and `src/index.ts`, `packages/core/session/src/repair.ts` and `src/types.ts`, `packages/core/tools/src/index.ts` and `apps/cli/src/profile-boot.ts` differ from `master` by 965 insertions and 1,372 deletions — and all eleven cherry-picks conflict. P5 and P8 replace the mechanism, so the port would be the double investment that already kept the TypeScript Step 3 (resume auto-continuation and chunk dedupe) out of this line.

**Keep the wait and shorten the backstop.** Rejected because the wait still encodes a handshake nobody implements; a shorter timeout only makes an incorrect model fail faster, and it keeps the host's exit governed by the supervisor's timer instead of by the host's own bounded shutdown.

**Drop `restart-request` and always TERM the listener.** Rejected because the file is the deployment's public restart interface: the restart script, agents, and restart timeline tooling write it, and once the supervisor stops waiting on it the file costs one `ls` per poll.

**Mark turns `pending` so a resume can continue them.** Rejected here for the reason recorded above: the event type and its consumers are P5 work. Synthesizing a marker with no reader would recreate exactly the defect this note removes.

## Consequences

A restart costs TERM, at most 5s of disposal, the 1–5s restart delay, and the health window — about 10–20s in production instead of 600s. Work in flight at the moment of a restart is lost to `interrupted` repair until P5 lands resume. The banner plugin is dormant and fail-closed: with the contract absent it reports `{supported: false}` and rejects the immediate-restart action instead of writing a signal nothing consumes.

## Verification

`dsfolder/scripts/check-restart-contract.sh` asserts the agreement between declaration and effect and carries a `--self-test` that injects each violation as a negative control: the host declares `SIGTERM → interrupt(0)` and contains no coordinator consumer; the supervisor has no coordination wait and TERMs the `:3080` listener; no profile manifest installs `dsh-restart-banner`; and no file in the tree (orphan build output included) names a restart coordinator. The log excerpt above is the reproduction of the defect the check prevents.
