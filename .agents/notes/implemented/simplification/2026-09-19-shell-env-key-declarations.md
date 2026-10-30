# Agent Note: Keep shell-environment declarations focused on key ownership

Status: implemented

English | [中文](2026-09-19-shell-env-key-declarations.zh.md)

## Problem

The [shell-environment registry](../../../../packages/shell/shell-env/src/index.ts) requires a description for every declared variable and exposes `list()` to enumerate it. Runtime collection uses only contributor identity, declared keys, and resolved values. [Bash](../../../../packages/shell/tool-bash/src/index.ts) and [PowerShell](../../../../packages/shell/tool-pwsh/src/index.ts) call `collect`; the [Web bundle](../../../../packages/bundle/web-app/src/index.ts) contributes `DSH_WEB_URL`. Searches found no fixed production caller of `list()` or consumer of its descriptions.

The method is nevertheless discoverable through the [Cordis inspection provider](../../../../packages/extensions/tool-cordis/src/providers.ts), so this is an explicit API contraction, not unreachable-code removal. The [original identity-and-log-location record](../../archived/feature/2026-07-10-agent-session-identity-and-log-location.md) anticipated diagnostics and future prompt/UI consumers. The current TODO and [README limitation](../../../../packages/shell/shell-env/README.md) still describe an incomplete catalog that omits built-in variables.

## Decision

A contributor's declaration is an explicit readonly collection of keys (`keys: readonly DshEnvironmentKey[]`). Description objects, `BashEnvVariable`, `BashEnvVariableInfo`, `list()`, description-only validation, and the exhaustive-catalog TODO are gone; the Web contributor, README pair, and generated service/type declarations moved with them. Declaring the same key twice inside one contributor is rejected.

Keep `register`, `collect`, reserved keys, ownership conflicts, undeclared-output refusal, deterministic environment output, and effect disposal. The [PowerShell parity reference](../../../../packages/shell/shell-env/README.md) continues to own the shared registry and both shell consumers. The proposal removes one public method, two metadata types, and their validation/enumeration tests; roughly 32 identified source lines disappear before the small key-membership adaptation.

## Alternatives considered

**Finish the diagnostics catalog.** That would add built-in metadata and a consumer capability without an identified current product requirement. The proposal instead gives up declarative environment descriptions and enumeration; actual shell environment values remain available through execution.

**Keep descriptions after deleting `list()`.** Rejected because they would have no remaining reader while still burdening every contributor. Preserve the key ownership declaration independently of presentation metadata.

## Testing

- Fixed callers, recordings, generic inspection, and current product requirements were re-checked before the removal; no diagnostics consumer needed the API, so it went.
- Contributors declare keys without description objects. Duplicate names, reserved keys, cross-contributor conflicts, undeclared outputs, and disposal retain their behavior.
- Bash and PowerShell receive equivalent environment maps, including Web URL and Session identity; no secret-handling or ambient-environment policy changes.
- Registry, Web-contributor, and shell integration tests cover the change; the inspection catalogs were regenerated, both READMEs updated, and typecheck, doc-sync, and lint pass.

## Consequences

Model-written and external plugins can already discover and call `list()`. They lose enumeration without resolver execution and must change contributor declarations. This pre-stable API loss is acceptable only while the anticipated diagnostics capability remains unowned; `collect()` is not advertised as an equivalent diagnostic replacement.
