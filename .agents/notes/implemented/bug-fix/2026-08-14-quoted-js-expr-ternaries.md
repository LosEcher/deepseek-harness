# Agent Note: Unquoted `!!js` ternaries collapse into YAML mappings

Status: implemented

English | [中文](2026-08-14-quoted-js-expr-ternaries.zh.md)

## Problem

A profile whose MCP row used an unquoted ternary such as `Authorization: !!js process.env.K ? \`Bearer ${process.env.K}\` : undefined` failed the entire plugin tree at boot. `!!js` is a YAML scalar tag; an unquoted `?` / `:` is mapping syntax, so js-yaml stored the expression node as the object key `[object Object]` and the header value never interpolated. `@deepseek-ai/dsh-mcp-client` then rejected `headers.Authorization` as a mapping, Include rolled back the whole child tree, and `dsh --dump-config` still succeeded because it does not evaluate `!!js`. `failOnStartupError: false` did not help: that flag covers connection failures, not config schema validation.

## Decision

After patches apply, Include walks the composed tree (`assertJsExprTree`) and throws if any mapping uses the key `[object Object]`. The diagnostic names the entry and tells the author to quote the scalar (`key: !!js "cond ? a : b"`). `dsh --dump-config` runs the same walk on the composed list so a daemon preflight fails before process start.

Per-layer parse stays permissive: an overlay may replace a bad bundle row, and only the composed tree is judged.

## Alternatives considered

**Fail at per-layer parse.** Would reject a bundle that a later overlay already repairs, and would make a working profile unloadable until every layer is edited.

**Teach js-yaml to treat the rest of a `!!js` line as a scalar.** Fights YAML tokenization; `??` and `||` already work unquoted, and only `?` / `:` are mapping syntax.

**Swallow one child's ValidationError inside Include.** Hides misconfiguration. Connection-time `failOnStartupError` stays the isolation for a reachable but down MCP server.

## Consequences

A quoted ternary, `??`, and `||` are unchanged. A composed tree that still carries a collapsed mapping now fails dump-config and boot with the same message instead of a schemastery dump of `{[object Object]: ...}`.

## Testing

`packages/boot/app-boot/tests/config-dump.spec.ts` rejects a composed unquoted ternary and accepts an overlay that replaces that row. `packages/boot/app-boot/tests/user-patches.spec.ts` rejects the same YAML at `boot()`.
