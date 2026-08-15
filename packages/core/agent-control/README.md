# dsh-agent-control

English | [中文](README.zh.md)

Process-safe Agent control Service Definition (`ctx.agentControl`). Callers hold `AgentDescriptor` records and issue named commands. They never receive a live `Agent`; `session`, `inbox`, and `ctx` stay inside the worker.

The live `Agent` interface remains the worker-local object graph documented by [`dsh-agent`](../agent/README.md). This package is the command, generation, backpressure, and session-ownership contract that `local-ts` and `worker-ts` implement.

## Service: `AgentControl` (ctx key: `agentControl`)

Abstract service. Load one provider (`dsh-agent-worker`) per context.

| Method | Role |
|---|---|
| `create` / `resume` | Start a generation and acquire event-stream ownership |
| `send` / `followup` / `steer` / `inject` | JSON-serializable inbox commands |
| `cancel` | Idempotent abort |
| `whenIdle` | Drained-strength quiescence |
| `flush` / `drain` / `dispose` | Durability and lease release |
| `get` / `list` / `roots` / `isOwnedBy` | Read-model queries |

Functions and Cordis contexts never appear in a payload. `runMaintenance` has no wire form.

## Session ownership

Writer identity is the last `session/ownership` event (`acquire` / `release`). A second generation cannot acquire while another generation still holds. Process exit is not proof of durability; only `drain` releases the lease for a planned switch.

## Model Experience

None, as this service never assembles a model request; the worker-local Agent owns every model-visible fact.

#### KV Cache effect

No direct invalidation; the worker-local composition owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Shipped profiles stay on the live `Agent` registry** — Host, ACP, and headless still program `ctx.agents` until those entrypoints are remoted onto this service.
- **Assembled product snapshots still run in-process** — worker-ts currently boots the spine plus a fixture adapter, not a shipped profile.
