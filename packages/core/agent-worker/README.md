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
| `workerProfile` | unset | Composed profile name; when set the worker boots the FULL profile composition (real adapters, tools, credentials, presets) instead of the fixture spine |

`local-ts` requires `ctx.agents` and `ctx.sessions` at load. `worker-ts` does not.

## Isolation

Killing one worker process cannot terminate the main process or another Agent. The supervisor marks that generation `faulted`. Resume is a new generation after drain or after the supervisor observes the child exit.

## Host invocation

`supervisor.invokeHost(id, namespace, method, args)` routes one Host Remote invocation into the worker's own composition (service `host` on the product bridge): the worker's typert gateway — mounted by `dsh-base` in any composed profile — resolves the endpoint from its own descriptor catalog, so Host RPC method bodies can run against the in-worker live `Agent` without a remote-object facade. `supervisor.invokeApiProxy(id, section, method, args)` dispatches one ApiProxy section method against the worker's mounted `ctx.apiProxy` (the worker-web composition, api-proxy ④). worker-ts only: local-ts holds agents in-process, where Host methods run directly.

## Model Experience

None, as this provider never assembles a model request; the worker-local Agent composition owns every model-visible fact.

#### KV Cache effect

No direct invalidation; the worker-local composition owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Shipped profiles still default to in-process `ctx.agents`** — this plugin is opt-in and does not change `web` or `headless`.
- **worker-ts defaults to the spine plus a fixture adapter** — set `workerProfile` to mount a full composed profile (real LLM adapters, tools, credentials, presets) inside the worker; shipped profiles still opt in per deployment. Prefer an execution-surface profile (headless): a control-surface profile (web) mounts listeners and ports.
- **Host, ACP, and SDK entrypoints are not remoted yet** — they still hold live `Agent` objects in the main process.
