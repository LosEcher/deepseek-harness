# Agent Note: Optional out-of-tree profile addons

Status: implemented

English | [中文](2026-08-15-optional-profile-addons.zh.md)

## Problem

A profile's include tree is one fail-loud unit. `EntryGroup.update` rejects when any sibling fails, `boot` then disposes the partial context, and the process exits. That is the right contract for installation-owned rows (`dsh-base`, `dsh-web-app`, `dsh-headless`): a broken session, LLM, or webserver row must not start half-assembled.

Out-of-tree bundles (`dsh plugin add`) and user-layer `insert` rows are not self-contained. A syntax error, missing `inject`, or stale `defineTool` call in one of those rows takes down the same process that serves every other plugin. `disabled: true` skips apply but still imports the module, so a top-level throw still fails boot. `--dump-config` does not import. MCP already isolates an external server with `failOnStartupError: false`; ordinary bundle rows had no equivalent.

## Decision

**Installation-owned rows stay fail-loud. Addon rows are quarantined for this process only.** A row is an addon when its id is not inserted by a bundle that resolves from the dsh installation anchor. That includes out-of-tree bundle inserts and user/home/`--patch` inserts. An id-targeted override of an installation-owned row stays core: breaking `llm` or `session` still fails the process.

`bootQuarantiningAddons` boots the composed tree, reads failed Loader entry ids (and activation-audit names) from the rejection chain, disables each failed addon, and retries. The disable is an in-memory patch; it is not written to `cordis.patch.yml`. The next process tries the addon again. A failure that names a non-addon row, or that names no addon row, is rethrown unchanged.

Vendor Loader is not forked. Isolation lives in app-boot because that is where profile composition already knows which bundles come from the installation. User-patch HMR already keeps the last good tree when a reapply is rejected, so a later enable of a still-broken addon does not tear down a running host.

`dsh plugin add` import-probes each newly joined out-of-tree bundle and warns on failure. The add still succeeds: the host quarantines the row if load still fails.

## Consequences

- A broken multimedia (or any other out-of-tree) row no longer prevents `dsh web` from listening.
- `--dump-config` still shows the addon as composed and enabled; quarantine is a boot-time fact, not a composition fact.
- `pluginInventory` lists a quarantined row as disabled, not `fiberPhase: failed`.
- Import-time throws are covered; a plugin that applies and later rejects asynchronously is still `installFailLoud`.
- Core-seam fail-loud and MCP `failOnStartupError` are unchanged.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| `optional` on vendored `EntryOptions` | Would fork Loader/Include; profile composition already knows ownership |
| Rewrite addon `name` through a wrapper plugin | Id-targeted user overrides replace whole `config` and would strip the wrapper |
| Second include / process isolation | Extra lifecycle for a problem that is boot classification, not an execution world |
| Persist `disabled: true` after a failed boot | A later fix would stay dark until someone edits the profile patch |
| Fail-soft the entire tree | A broken `session` or `llm` row must not start |
