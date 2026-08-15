# dsh-agent-worker

English | [中文](README.zh.md)

`local-ts` and `worker-ts` provider for [`dsh-agent-control`](../agent-control/README.md). Backend selection is an explicit Config field resolved when the plugin loads and reported as `backend`; it is never a hidden fallback.

`local-ts` wraps the in-process `ctx.agents` registry. `worker-ts` spawns one Node child per Agent, speaks the product bridge on stdio, and keeps the live `Agent` inside that child.

## Config

| Key | Default | Notes |
|---|---|---|
| `backend` | `'local-ts'` | `'local-ts'` or `'worker-ts'` |
| `commandQueueLimit` | `32` | Full queue rejects with `busy` |
| `eventCredit` | `64` | Unacknowledged `session-event` budget |
| `replayWindow` | `1024` | Resume replay bound; `0` is rejected |
| `sessionRoot` | unset | JSONL root the worker mounts for drain-and-resume |

`local-ts` requires `ctx.agents` and `ctx.sessions` at load. `worker-ts` does not.

## Isolation

Killing one worker process cannot terminate the main process or another Agent. The supervisor marks that generation `faulted`. Resume is a new generation after drain or after the supervisor observes the child exit.

## Model Experience

None, as this provider never assembles a model request; the worker-local Agent composition owns every model-visible fact.

#### KV Cache effect

No direct invalidation; the worker-local composition owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Shipped profiles still default to in-process `ctx.agents`** — this plugin is opt-in and does not change `web` or `headless`.
- **worker-ts boots the spine plus a fixture adapter** — not a shipped product composition. Assembled snapshots stay on `local-ts` until the worker mounts the same plugins as those snapshots.
- **Host, ACP, and SDK entrypoints are not remoted yet** — they still hold live `Agent` objects in the main process.
