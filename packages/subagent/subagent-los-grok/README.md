---
description: "Optional Profile bundle that registers a one-shot LOS Grok subagent provider for delegated external-runtime work."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-los-grok

English | [中文](README.zh.md)

## Summary

Install `@deepseek-ai/dsh-subagent-los-grok` into a Profile when a delegated one-shot task should run on LOS's bounded Grok runtime. Each run probes `GET /runtimes/capabilities`, calls `POST /runtimes/grok/run` only when Grok is runnable and available, and returns captured SSE text or a safe failure diagnostic. LOS remains authoritative for capability, process lifecycle, and evidence. The Bundle registers a dormant provider; the model reaches it only through a delegation tool row.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider when a delegation should execute as one LOS Grok external-runtime task in the parent Session workspace. Install the Bundle into a Profile, optionally configure the provider row, and expose it through a delegation tool row.

### Installing the Bundle

Install the package into the target Profile, then restart that Profile. The declared patch layer registers only the dormant provider and starts no LOS process.

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-los-grok
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-los-grok
dsh --profile <name>
```

Removing the package withdraws the provider on the next Profile start. Installation controls Host availability, not model permission: the model can only reach the provider through a delegation tool row you compose.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `los-grok` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `baseUrl` | `http://127.0.0.1:8080` | LOS gateway origin; a trailing slash is stripped at load |
| `authTokenEnv` | `LOS_AUTH_TOKEN` | Environment variable that supplies the LOS bearer token |
| `operatorTokenEnv` | `LOS_OPERATOR_TOKEN` | Environment variable that supplies the LOS operator token |
| `timeoutMs` | `300000` | Integer bound, 1000–600000, on one runtime request |
| `outputLimitBytes` | `128000` | Integer bound, 4096–512000, on captured SSE text |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-los-grok) is the exhaustive source for every accepted field and its JSDoc. Credentials are read only from the named environment variables; they are never taken from plugin config.

### Exposing the tool

Each delegation tool row names one provider and needs its own `toolName`.

```yaml
- id: tool-subagent-los-grok
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: los-grok
    toolName: subagent_los_grok
    backgroundMode: one-shot
    maxDepth: provider-managed
```

### What you get

A completed run returns the captured Grok output as assistant text. Capability misses, non-zero exits, missing terminal events, HTTP failures, and timeouts settle as `error` with a safe diagnostic. Caller cancellation settles as `aborted`. HTTP 200 and `runtime.completed` with a non-zero exit code are not treated as task success.

### Failure and recovery

When Grok is not both `implementation: runnable` and `available: true`, the run fails closed before `POST /runtimes/grok/run`. Missing parent Session cwd fails before publication. A cancelled run settles as `aborted`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the provider talks to LOS; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One-shot HTTP runtime.** Every run probes capabilities, then consumes one bounded SSE stream; there is no continuation or resume.
- **LOS is authoritative.** Capability, process exit, and terminal events come from LOS; DSH does not duplicate that agent loop.
- **Fail closed.** An unavailable runtime, missing terminal, or non-zero exit is an error, not a successful empty answer.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/run.ts`](src/run.ts) | Capability probe, SSE translation, result settlement |
| [`cordis.patch.yml`](cordis.patch.yml) | The Profile patch layer that registers the dormant provider |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [Codex subagent provider](../subagent-codex/README.md) — a sibling out-of-process product backend.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-los-grok) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The LOS Grok runtime receives the standalone text blocks as one prompt, with the parent Session cwd as `workspaceRoot`. Image and other non-text blocks are omitted from that prompt.

#### Token effect

The child pays for an independent LOS Grok context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on LOS and the Grok runtime.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent the captured Grok text or an error containing the stop reason and optional safe diagnostic. A background call first returns a Job id; the generic job controls later deliver that same outcome.

#### Token effect

The parent pays for the tool result text or Job id. LOS SSE frames, credentials, and raw HTTP bodies stay out of the parent Session.

#### KV Cache effect

The parent prefix is unchanged until the tool result or Job id is appended.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this provider is a poor fit. They are current package constraints.

- **One-shot only** — there is no continuation, resume, pooling, or progress stream.
- **No optional shared capabilities** — `agentOptions`, output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service.
- **Authentication stays in named environment variables** — the Bundle does not mint LOS tokens or rewrite LOS config.
- **No wall-clock timeout beyond `timeoutMs`** — the caller cancels longer work, and files changed before cancellation are not restored.
- **Live LOS execution is operator-owned** — unit tests inject `fetch`; a real Grok task needs operator credentials and a reachable gateway.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
