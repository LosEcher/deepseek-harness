# Agent Note: Retire the prompt registry change event

Status: implemented

English | [中文](2026-09-19-retire-prompt-registry-change-event.zh.md)

## Problem

[`SystemPrompt`](../../../../packages/core/system-prompt/src/index.ts) emits `system-prompt/change` when providers register or dispose. Repository searches find no executing product listener, but generated Host discovery advertises the event. Tests maintained notification counts and rollback after listener exceptions. This is a public extension with maintenance obligations, even without a first-party subscriber.

The proposal recorded the active [Remote event delivery reference](../../../../packages/api/remotes/README.md) as explicitly retaining this extension. Re-checking it before the removal found no such retention: its forwarded-event allowlist never carried `system-prompt/change`. Per-step assembly predates that promise and serves a different purpose: rebuilding model input does not replace push observation of registry changes.

## Decision

`system-prompt/change` is retired, and prompt-registry push observation is gone for installed and dynamically authored Host plugins. Its declaration, emitter, current documentation, generated discovery entries, and notification-specific tests went with it. No supported product path required the extension.

Make [`ScopedLayers`](../../../../packages/core/scope/src/store.ts)'s constructor notification callback optional and omit it for `SystemPrompt`; do not supply a no-op callback. Remove the existing no-op arguments in [jobs-local](../../../../packages/jobs/jobs-local/src/index.ts) and [mcp-resources](../../../../packages/mcp/mcp-resources/src/index.ts) when updating this shared constructor, and update jobs-local's adjacent notification explanation. Preserve shared effects, action rollback, undo ordering, layer reclamation, and `tools/change` with its production consumers. Keep prompt-provider evaluation, scope shadowing, and assembly invariants.

No amendment was needed in that note: it never listed the event, so its retained-extension statement stayed accurate, and its forwarding policy and other extensions remain independently useful. Two historical `## Alternatives considered` sections still name the event while explaining 2026-07 decisions; they describe what existed then and were left as written.

## Alternatives considered

**Keep the extension for future dashboards or plugins.** Push observation could support a real consumer, but none is identified in supported product paths. Retention preserves notification and listener-failure behavior that the package otherwise does not need.

**Treat per-step assembly as proof of compatibility.** Rejected because model-input reconstruction and registry notifications are different behaviors. This proposal deliberately changes the extension promise rather than claiming the earlier reconstruction decision already removed it.

## Testing

- The event is gone from source and from the current generated inventories.
- Notification-count and notification-failure tests were removed; provider-membership, disposer, duplicate-registration, shadowing, and HMR coverage remain, and mixed tests keep their independent assertions. The throwing-listener rollback path stays covered through `tools/change`.
- Focused scope, tools, system-prompt, jobs-local, and mcp-resources tests, catalog generation, typecheck, lint, and doc-sync cover the change; prompt and log output are unchanged.

## Consequences

Installed plugins may depend on notifications or on listener exceptions rejecting registration. They lose both behaviors; repository searches cannot establish their absence. A future push consumer needs an explicit registration-observation requirement and ownership design before reintroducing an event. Source savings are small; the benefit is retiring the public notification and failure obligation.
