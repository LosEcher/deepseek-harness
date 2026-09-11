# Agent Note: Seed the deleted client-runtime specifier

Status: implemented

[English](2026-09-12-client-runtime-seed-alias.md) | 中文

## Problem

树外 client 半包仍 `require("@deepseek-ai/dsh-client-runtime/client")`。该包在 0.1.5-rc.2 上已经不在；`defineStore` 在 `@deepseek-ai/dsh-client-store`。模块表于是抛出 `missed the module table`，web shell 报 Failed to load plugins——先是 `dsh-client-ui-theme`（过期的第一方产物），然后是 `dsh-context-doctor`，然后是 `dsh-llm-fallbacks`。

## Decision

`getStaticModules()` 保留现行 `PLATFORM_MODULES` 表，并把 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-runtime/client` 种到同一份 `dsh-client-store` 实例上。别名不进入 `PLATFORM_MODULES`，这样第一方 client externals 不会继续点名已删除的包。

## Alternatives considered

**重建每个已安装的 profile 插件。** 对操作者自己的包是对的，`dsh-context-doctor` 已经这样做。它覆盖不了 github 安装的半包，例如 `dsh-llm-fallbacks`，其 `client.js` 仍点名旧 specifier。

**把 `@deepseek-ai/dsh-client-runtime` 恢复成一个包。** 否决：store 拆分才是现行模块身份；再做一个包会重复 seed。

## Consequences

只从旧 specifier 使用 `defineStore` / `EngineStoreHandle` 的 0.1.0 时代 client 半包可以在 0.1.5-rc.2 上加载。新的第一方代码继续导入 `@deepseek-ai/dsh-client-store`。若半包还 require 过 runtime 的其他导出，仍会失败，直到该半包重建。
