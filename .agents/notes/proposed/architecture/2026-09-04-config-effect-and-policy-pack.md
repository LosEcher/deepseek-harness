# Agent Note: Config effect catalog and policy pack

Status: proposed

English | [中文](2026-09-04-config-effect-and-policy-pack.zh.md)

## Problem

A running dsh is already a composed plugin tree: bundles, then the profile `cordis.patch.yml`, then the home patch, then `--patch`. The generated [config catalog](../../../docs/config-catalog.md) is the deployment-axis reference for every `config:` block. Operators still cannot answer three questions from that catalog or from `--dump-config`:

1. After this key changes, what must refresh (HMR, process restart, new session, page refresh)?
2. May an overlay patch a single nested field, or must it restate the whole row `config`?
3. Which approval, sandbox, timeout, reminder, and MCP filter knobs are one policy, and which are independent plugin rows?

Those answers live in comments, skills, and postmortem 0002 (`!!js` evaluated in the wrong metadata slot). Whole-row replace is the documented loader contract ([architecture.md](../../../docs/architecture.md) Profiles and bundles; [dsh-base patch](../../../packages/bundle/base/cordis.patch.yml) header). It prevents silent merge of mode-specific rows, and it is also the usual way an MCP overlay drops `serverName` and fails the tree. `toolAllow` / `toolDeny` / `descriptionMaxLength` exist on `@deepseek-ai/dsh-mcp-client` in source and tests, and are still absent from the generated catalog paste. `@deepseek-ai/dsh-tool-call-timeout-policy` wraps `tools/execute` and has no catalogued config; budgets live on each tool row (`timeoutMs`, `searchTimeoutMs`). Permission already has a table (`dsh-permission-presets`) that writes through `sandbox-policy` and `approval`. There is no authoring document that compiles one policy object onto those shipped rows, and no fixture suite that says "this pack allows or denies this call."

This note freezes the schemas and the mapping onto shipped packages. It does not change loader behavior in this change.

## Proposal

Ship two additive contracts, both projections of the existing composition model:

- **Config effect catalog** — every catalogued config key declares an effect class. `--dump-config` prints it. A later gate fails a docs or skill claim that contradicts the class.
- **Policy pack** — one YAML document operators edit. A compiler (not a second runtime authority) expands it into id-targeted patches against the shipped rows in `dsh-base`. The config catalog remains the deployment axis.

Do not add a parallel config tree. Do not put drain/resume state-machine tables in this note; that remains a follow-up owned by the agent loop.

### Scope

This proposal covers:

- effect classes and how they attach to the generated catalog
- overlay merge rules that stay compatible with whole-row replace
- the `!!js` evaluation surface
- the policy-pack schema and its compile targets in `packages/bundle/base/cordis.patch.yml`
- phased acceptance that starts with documentation and catalog freshness

### Non-goals

- Changing Cordis Loader, HMR, or quarantine in this proposal.
- A Starlark or CEL policy DSL.
- Making drain/resume, tool-exposure bitfields, or an external SQ/EQ protocol part of the pack.
- Deep-merging mode-specific rows that the base patch header forbids from living in `dsh-base`.

### Config effect classes

Every catalogued key, including nested keys the generator already cross-checks against schemastery, carries exactly one class:

| Class | Meaning | Typical owner |
|---|---|---|
| `hot` | Same process, same fiber; config-only HMR or the settings document applies it | `dsh-settings-file` sections, user-patch HMR of config-only rows |
| `restart` | Host process must restart; ESM module identity does not reload | host plugin `name`, bundle add/remove, `inject` graph |
| `new-session` | Live tree may already be `fiberPhase: active`; model-facing tool schemas and prompt assembly are snapshotted per session | MCP tool lists, `dsh-tools` `mode`, system-prompt `toolOrder` |
| `page-refresh` | Client half-bundle or slot registration; refresh the web page, do not restart the host | `dsh.client` artifacts served from link installs |
| `boot-quarantine` | Failure isolates this process for addon rows only; installation-owned rows still fail boot | out-of-tree inserts per [optional profile addons](../../implemented/architecture/2026-08-15-optional-profile-addons.md) |

Rules:

- A row can mix classes across keys (`mcp-client.toolCallTimeoutMs` is `hot` if the plugin reapplies config; `mcp-client.command` is `restart` because it respawns the child). The catalog lists the class per key, not per package.
- `new-session` is not a substitute for `restart`. RPC `pluginInventory/list` remaining `active` is not evidence that an existing session sees new tool schemas.
- `boot-quarantine` is a failure class, not a refresh class. `--dump-config` still shows the composed enabled row; quarantine is a boot-time fact.

### Catalog extension

Extend `scripts/gen-config-catalog.ts` so each pasted key carries an `@effect` JSDoc tag (or a schemastery meta field the generator reads). `pnpm run verify-config-catalog` fails when a schema-validated key has no class, or when the class is not one of the five names above.

`--dump-config` annotates each printed key (comment or sibling map). Skills and cookbooks that mention refresh behavior must name the class; a later doc-sync check can grep for "restart" / "HMR" claims against the generated table.

Until the generator ships, the inventory table in this note is the proposed assignment for the policy-relevant rows.

### Overlay merge

Keep last-write-wins by row id. Change the *payload* of an id-targeted override from opaque whole-object replace to schema-driven apply:

1. The overlay names the row `id`.
2. For each key present in the overlay `config`, the loader looks up that key on the package's schemastery schema.
3. Object-valued keys whose schema marks `merge: replace` (argv arrays, `presets` maps when the overlay intends a new table) replace.
4. Object-valued keys whose schema marks `merge: deep` (typical nested option objects) deep-merge.
5. Keys absent from the overlay stay as the previous layer wrote them.
6. Required keys missing after apply still fail validation — the overlay no longer has to restate them unless it replaces a `merge: replace` object that contained them.

`dsh plugin patch --from-dump <id>` (CLI, later phase) prints a full-row overlay for operators who want today's copy-paste behavior.

This does not merge *across* mode bundles. A value that differs by web vs headless still does not live in `dsh-base`; each mode bundle restates that row's complete configuration, as the base patch header already requires.

### `!!js` expression surface

Postmortem 0002 and the include primer already restrict `!!js` to config scalars and `disabled`. This proposal makes that a schema fact:

- A key is expression-capable only when the catalog/schema marks `expr: true`.
- `!!js` in row metadata other than `disabled` is a load error.
- An unquoted YAML mapping that parses as an object where a scalar expression was intended remains a load error (current failure mode); the catalog JSDoc must show a quoted example for every `expr: true` key that uses a ternary.

Shipped `expr: true` keys in `dsh-base` (non-exhaustive, from the patch file): `sandbox-policy.mode`, `sandbox-policy.workspaceRoot`, `bash-sandbox.disabled`, `pwsh-sandbox.disabled`, `approval.policy`, `session-persistence-jsonl.root`, and several `disabled:` metadata flags.

### Policy pack

A policy pack is a YAML file with a frozen `$schema` id. It is **authoring input**. The compiler emits ordinary patch rows. At runtime the plugins named below remain the authority; the pack must not be read by the agent loop.

```yaml
# $schema: https://deepseek-ai.github.io/deepseek-harness/schemas/policy-pack/v1.json
version: 1
approval:
  policy: ask          # maps to row id approval (dsh-user-approval)
sandbox:
  mode: workspace-write  # maps to row id sandbox-policy
permission:
  defaultPreset: workspace-write  # maps to row id permission
reminders:
  thresholds: [3, 5, 8]           # maps to row id repeat-tool-reminder
  argumentsPreviewChars: 500
timeouts:
  # Compile-time patches of rows that already declare timeoutMs / searchTimeoutMs.
  # Does not add config to dsh-tool-call-timeout-policy (that plugin has none).
  bashSandboxMs: 60000            # row id bash-sandbox
  webSearchMs: 60000              # row id tool-web.searchTimeoutMs
mcp:
  - serverName: context7          # matches an existing mcp-client row
    toolAllow: [resolve-library-id]
    descriptionMaxLength: 200
```

Compile rules:

- Unknown pack keys fail. Pack keys that do not map to a catalogued plugin key fail.
- `mcp[]` entries patch by `serverName` against already-inserted `dsh-mcp-client` rows; they do not insert servers. Inserting a server remains an overlay `insert`.
- Empty `toolAllow` remains "allow all" (shipped mcp-client contract). `toolDeny` wins.
- `approval.policy` and `sandbox.mode` must be consistent with `permission.defaultPreset` when that preset exists; mismatch fails compile rather than letting the two knobs drift (today `DSH_PERMISSION_MODE` is duplicated into both `sandbox-policy.mode` and `approval.policy` in the base patch).
- Fixtures live next to the pack: each fixture names a tool call (name + canonical args) and the expected pre-execute decision (`allow` / `deny` / `ask`). The suite drives the shipped approval + sandbox-policy + repeat-reminder plugins, not a mock interpreter.

### Phasing

1. **This note** — schemas, inventory, rejected alternatives. No runtime change.
2. **Catalog freshness** — `@effect` (and later `expr` / `merge`) on policy-relevant packages; regenerate config-catalog; print classes on `--dump-config`. Add `toolAllow` / `toolDeny` / `descriptionMaxLength` to the mcp-client catalog paste (they are already in source).
3. **Overlay apply** — schema-driven key apply with default "omit means keep"; `merge: replace` on argv and on maps the overlay restates.
4. **Policy-pack compiler** — `dsh policy apply --file pack.yml --profile web` writes or prints a patch. Fixtures in CI.
5. **Follow-ups, not this pack** — drain/resume decision table; tool-exposure budgets; bundle `trust` field (quarantine already classifies by installation anchor).

## Inventory against shipped rows

Proposed effect classes for the policy-relevant `dsh-base` rows. Other catalog packages gain classes in the generator pass; they are not listed here.

| Row id | Package | Keys in play | Proposed effect | Pack mapping |
|---|---|---|---|---|
| `approval` | `dsh-user-approval` | `policy` | `hot` if reapply; else `restart` | `approval.policy` |
| `sandbox-policy` | `dsh-sandbox-policy` | `mode`, `workspaceRoot` | `new-session` (session cwd/mode) | `sandbox.mode` |
| `permission` | `dsh-permission-presets` | `presets`, `defaultPreset` | `new-session` | `permission.defaultPreset` |
| `timeout-policy` | `dsh-tool-call-timeout-policy` | *(none catalogued)* | n/a | not a pack key |
| `bash-sandbox` | `dsh-bash-sandbox` | `timeoutMs` | `hot` | `timeouts.bashSandboxMs` |
| `tool-web` | `dsh-tool-web` | `searchTimeoutMs`, `fetch` | `new-session` for fetch visibility; `hot` for timeout | `timeouts.webSearchMs` |
| `repeat-tool-reminder` | `dsh-repeat-tool-reminder` | `thresholds`, `include`, `exclude`, `argumentsPreviewChars` | `hot` | `reminders.*` |
| `tools` | `dsh-tools` | `mode`, `maxParallelSubCalls` | `new-session` | out of pack (presentation, not policy) |
| `agent-loop` | `dsh-agent-loop` | `maxParallelToolCalls`, `agents` | `restart` for `agents`; `hot` for the cap if reapply exists | out of pack |
| `mcp-client` rows | `dsh-mcp-client` | `serverName`, `command`/`url`, `toolAllow`, `toolDeny`, `descriptionMaxLength`, `failOnStartupError`, `toolCallTimeoutMs` | `restart` for transport identity; `new-session` for allow/deny/description; `hot` for timeout | `mcp[]` by `serverName` |
| `session-query-sqlite` | `dsh-session-query-sqlite` | `openAt`, `path` | `restart` | out of pack |
| `hmr` | `cordis-plugin-hmr` | `root` | `restart` | out of pack |

`dsh-tools.mode` stays out of the pack because it changes model presentation (`native` / `code` / `both`), not allow/deny. A later tool-exposure proposal may reference this inventory.

## Alternatives considered

**Make the policy pack a new Cordis plugin that the loop reads.** Rejected: the catalog would then have two authorities for approval and sandbox. Compile-to-rows keeps [config-catalog](../../../docs/config-catalog.md) as the only deployment axis and lets `--dump-config` remain the boot truth.

**Deep-merge every overlay `config` object by default.** Rejected: the base patch header exists so web and headless do not silently combine mode-specific keys. Schema-marked `merge: replace` plus "omit means keep" preserves that split.

**Put effect classes only in a skill or cookbook.** Rejected: skills drift; the catalog is already generated and freshness-gated. Effect without a generator is the current failure mode.

**Starlark (or CEL) instead of a frozen YAML pack.** Rejected for this phase: parse-time examples are valuable (Codex execpolicy), but DSH already has schemastery and fixture tests. A DSL is a new language for operators who today edit `cordis.patch.yml`. Revisit only if fixtures cannot express a needed predicate.

**Teach timeout-policy a default `timeoutMs` config.** Deferred: the plugin is an execute wrapper over each tool's declared budget. Inventing a second default would fork the budget owner. The pack patches rows that already declare milliseconds.

**Include drain/resume in the pack.** Rejected for this note: drain is loop semantics and needs its own fixture-owned state table, not an operator YAML that could imply "persistent state authorizes automatic continue" (already rejected on 2026-06-20 for truncating interrupted turns, and again for goal auto-resume).

## Acceptance criteria

- This triplet is the owning proposal. Implementation PRs update it in the same change.
- Phase 2: every policy-relevant catalog key in the inventory table has an `@effect` (or schema meta) class; `verify-config-catalog` fails a missing class; mcp-client filter keys appear in the generated paste.
- Phase 2: `--dump-config` output for those keys includes the class.
- Phase 3: an overlay that sets only `toolAllow` on an mcp-client row keeps `serverName` and `transport` from the previous layer; a fixture proves a missing required key after a `merge: replace` of a nested object still fails loud.
- Phase 4: `dsh policy apply` on the example pack above produces patches targeting `approval`, `sandbox-policy`, `permission`, `repeat-tool-reminder`, and a named mcp-client row; a fixture directory fails CI when a pack/fixture pair disagrees with shipped pre-execute behavior.
- No phase of this proposal reads the pack from `packages/core/agent-loop`.

## Risks

- Mis-tagging a `restart` key as `hot` teaches operators to skip a required reboot. The generator default for an untagged key must be `restart` (fail closed), not `hot`.
- Schema-driven merge can hide a key the operator meant to clear. Clearing requires an explicit null/empty according to that key's schema; the compiler and overlay docs must say so.
- Compiling a pack into the profile patch while also hand-editing the same row ids will last-write-win and surprise. `dsh policy apply` must mark generated rows (comment or `patched by policy-pack`) and refuse to clobber a newer hand patch unless `--force`.
- Effect classes describe intended refresh, not a new HMR implementation. A key tagged `hot` whose plugin does not reapply still needs a restart; the catalog JSDoc must not claim live behavior the plugin lacks.
- This proposal knowingly leaves drain/resume, tool-exposure budgets, and bundle trust fields to later notes so the first implementation can stay on catalog + overlay + compile-to-rows.
