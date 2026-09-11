# Agent Note: Seed the deleted client-runtime specifier

Status: implemented

English | [中文](2026-09-12-client-runtime-seed-alias.zh.md)

## Problem

Out-of-tree client bundles still `require("@deepseek-ai/dsh-client-runtime/client")`. That package is gone on 0.1.5-rc.2; `defineStore` lives on `@deepseek-ai/dsh-client-store`. The module table then throws `missed the module table` and the web shell reports Failed to load plugins — first `dsh-client-ui-theme` (stale first-party artifact), then `dsh-context-doctor`, then `dsh-llm-fallbacks`.

## Decision

`getStaticModules()` keeps the live `PLATFORM_MODULES` table and also seeds `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-client-runtime/client` onto the same `dsh-client-store` instance. The aliases stay off `PLATFORM_MODULES`, so first-party client externals do not keep naming the deleted package.

## Alternatives considered

**Rebuild every installed profile plugin.** Correct for packages this operator owns, and done for `dsh-context-doctor`. It does not cover github-installed bundles such as `dsh-llm-fallbacks` whose `client.js` still names the old specifier.

**Restore `@deepseek-ai/dsh-client-runtime` as a package.** Rejected: the store split is the live module identity; a second package would duplicate the seed.

## Consequences

A 0.1.0-era client bundle that only used `defineStore` / `EngineStoreHandle` from the old specifier loads on 0.1.5-rc.2. New first-party code keeps importing `@deepseek-ai/dsh-client-store`. A bundle that required other former runtime exports still fails until that bundle is rebuilt.
