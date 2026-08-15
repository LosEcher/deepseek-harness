# Agent Note: Agent control Service Definition and Node worker supervisor (P1)

Status: implemented

English | [中文](2026-08-15-agent-control-p1.zh.md)

## Problem

The live `Agent` interface cannot cross a process boundary. P0 defined the process-safe control protocol, the bridge mapping, event-stream ownership, and the consumer classification, but no TypeScript Service Definition or supervisor existed, so Agent isolation could not be claimed.

## Decision

P1 ships three packages and confirms the P0 lease and placement decisions.

`@deepseek-ai/dsh-bridge-protocol` is the TypeScript owner of product-bridge messages, Content-Length framing, and handshake pairing. `node_root` pairs with `node_worker` as well as `rust_sidecar`.

`@deepseek-ai/dsh-agent-control` is the Service Definition (`ctx.agentControl`). Callers hold `AgentDescriptor` records and issue named commands. The live `Agent` stays worker-local.

`@deepseek-ai/dsh-agent-worker` is the provider. `backend` is an explicit Config field, default `local-ts`. `local-ts` wraps `ctx.agents`. `worker-ts` spawns one Node child per Agent and speaks the bridge on stdio.

Session writer identity is the last `session/ownership` event (P0 candidate B). A second generation cannot acquire while another generation still holds. `drain` is idle + flush + release; process exit is not proof of durability.

The twelve P0 boundary items keep the recommended placement: agent-lookup becomes a remote-projection factory; tools scope re-keys by `sessionId`; tool execution follows the worker; subagent stays worker-local; WeakMap keys move to `sessionId` before more entrypoints remoted.

Shipped `web` and `headless` profiles still program `ctx.agents`. worker-ts boots the spine plus a fixture adapter. Assembled product snapshots stay on the in-process path until the worker mounts that composition.

## Alternatives considered

**Return a remote object typed as `Agent`.** Rejected in the isolation proposal; P1 does not re-open it.

**External lease file as the worker-protocol lease.** Rejected as P0 candidate A: it adds a third single-writer mechanism and still needs staleness proof. The disk file remains a P3 leaf primitive, not this protocol's lease.

**Change shipped profiles to `worker-ts` in the same step.** Rejected: the worker composition is the spine, not a product profile. Isolation is proven by conformance and crash tests first.

**Put protocol types only inside `dsh-agent-worker`.** Rejected: Rust facades and Agent workers share one IPC primitive set.

## Consequences

Main-process plugins that still read `agent.session`, `agent.inbox`, or `agent.ctx` remain implicit remote-object risks until those plugins move or remoted. The classification table in the [P0 note](../../proposed/architecture/2026-08-15-agent-control-protocol-p0.md) is the placement map.

`session/ownership` is required-on-read. A writer that does not understand it must refuse the log.

Per-Agent process cost is unmeasured. Pooling stays out of scope.

## Required verification

- `packages/core/agent-control/tests/agent-control.spec.ts` admits the positive fixture corpus and rejects the negative corpus with the recorded phrases; ownership refuses a second acquirer.
- `packages/core/agent-control/tests/invariant.spec.ts` rejects a second acquire and a release without acquire.
- `packages/core/agent-worker/tests/agent-worker.spec.ts` covers local-ts create/followup/drain, local-ts drain-and-resume with JSONL, worker-ts sibling survival after SIGKILL, and worker-ts drain-and-resume.
- `packages/util/bridge-protocol/tests/bridge-protocol.spec.ts` covers framing, handshake pairing including `node_worker`, and priority frames.

## Named coverage gaps

- Assembled keyless snapshots are not yet run through `worker-ts`.
- Host, ACP, and SDK entrypoints still hold live `Agent` objects.
- Receiver-credit exhaustion under a busy session-event stream is unit-covered in admission, not stressed as a long-running worker.
