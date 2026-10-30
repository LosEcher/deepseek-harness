# Agent Note: Read instruction files only through a filesystem provider

Status: implemented

English | [中文](2026-09-19-provider-only-instruction-reads.zh.md)

## Problem

[Instruction discovery](../../../../packages/context/agent-instructions/src/files.ts) maintains provider and direct-Node paths for metadata probes, root-marker discovery, and bounded reads. `nodeStatFile`, `nodeTextChunks`, and optional provider/target fields support the latter. The exported `discoverBaselineInstructionFiles` wrapper selects it; `loadBaselineInstructions` permits it when callers omit a provider.

Every repository production caller supplies a provider. The [plugin](../../../../packages/context/agent-instructions/src/index.ts) reads `ctx.get('fs')` and returns when absent; [reconciliation](../../../../packages/context/agent-instructions/src/state.ts) requires `FileSystem`. Direct-Node consumers are tests. Maintaining both paths therefore adds separate error and cancellation coverage without serving a shipped product path.

## Decision

`FileSystem` is required throughout discovery and loading, including both exported wrappers and `findProjectRoot`. Remove `nodeStatFile`, `nodeTextChunks`, Node-only missing-path classification, the Node branch of `existsAsMarker`, and the `statFile` selector. Provider discovery supplies required targets; bounded reads consume those targets through `streamText`.

Keep the plugin's missing-provider no-op and the pure `renderAgentInstructions` API. Preserve candidate precedence, source and rendered-output byte budgets, cancellation, symlink following, and error semantics: unavailable candidates cannot imply removal, while root-marker failures remain errors. The separate `skill-filesystem` owner retains its existing providerless behavior.

Direct helper tests now own an explicit provider: the [test suite](../../../../packages/context/agent-instructions/tests/agent-instructions.spec.ts) builds a `localProvider()` and wraps it to count or fault provider calls. Two Node-mocked cases had silently stopped testing anything once the Node fallback went away — the probe-count and unavailable-candidate cases — and now inject through the provider instead. Unique assertions were preserved; the deletion measured roughly 79 production lines including JSDoc.

The [agent-instructions reference](../../../../packages/context/agent-instructions/README.md) owns the retained symlink-loading behavior. Its provider-read descriptions and Chinese counterpart were updated with the removal. The [archived workspace-context note](../../archived/feature/2026-06-24-workspace-context.md) remains frozen; this proposal requires no change to that historical record.

## Alternatives considered

**Keep providerless convenience exports.** They let external callers load instructions without constructing a provider, but require a second I/O implementation that production bypasses. This proposal deliberately gives up that convenience; repository searches do not establish external non-use.

**Construct a local provider implicitly.** This preserves the omitted argument while hiding filesystem selection and lifecycle ownership. Callers should supply the implementation they intend to use.

## Testing

- This owner's discovery/read helpers require a provider and contain no direct-Node I/O fallback; providerless plugin composition still loads nothing.
- Focused tests preserve symlink, absence/unavailability, marker-error, budget, cancellation, resume, nested-touch, and compaction-restoration behavior.
- The workspace-context resume process expectation and `ptc-workspace-context` scenario retain their text and event order. Typecheck, affected builds, and documentation checks pass.

## Consequences

External callers omitting the provider face an intentional pre-stable API change. Those requirements were checked before the removal. Keep filesystem extension paths intact, and do not replace useful provider tests with a new convenience wrapper that recreates the removed fallback.
