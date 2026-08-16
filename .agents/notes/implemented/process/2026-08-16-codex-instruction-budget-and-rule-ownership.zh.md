# Agent Note: Codex 指令预算与规则归属

Status: implemented

[English](2026-08-16-codex-instruction-budget-and-rule-ownership.md) | 中文

## Problem

Codex 从全局文件到当前工作目录构建一条项目指令链，默认上限为 32 KiB。全局指令与仓库根指令已经占用大部分预算，因此从 `docs/` 或 `packages/client/` 启动 Codex 时，最接近当前目录的指令可能被截断。根文件还承载了仅适用于包的运行时与 TypeScript 规则，使仓库内所有任务都要为只在 `packages/` 下生效的指导承担上下文成本。

## Decision

仓库提交 `.codex/config.toml`，设置 `project_doc_max_bytes = 65536`。这个仓库级设置只提高项目文档预算，并在仓库受信任时生效；提供方、认证、MCP、遥测与权限设置仍由用户配置拥有。

根 `AGENTS.md` 拥有跨仓库区域生效的规则，并明确将包工作路由到 `packages/AGENTS.md`。包指令文件保留硬性入口检查，并把贡献者路由到 `packages/RULE.md`；后者拥有包命名、ESM 执行、插件生命周期、事件日志、包边界、工具展示与包覆盖政策。嵌套指令文件继续对其目录生效；提高预算可防止直接从子目录启动时丢失最具体的文件。

## Alternatives considered

**在全局 Codex 配置中提高上限。** 拒绝，因为预算压力由本仓库的指令树证明；全局提高会在没有其他仓库明确需求时扩大它们可用的提示词预算。

**保留根文件中的所有规则，只提高上限。** 拒绝，因为只处理根目录的任务仍会承担包规则成本，后续增加包规则也会继续扩大最宽的指令层。

**把所有包规则直接放入 `packages/AGENTS.md`。** 拒绝，因为子树指令有刻意设置的较小字数预算。简短入口文件加链接政策可保留自动护栏，同时只在包工作中加载完整细节。

**依赖 agent 手工读取嵌套文件。** 拒绝，因为 Codex 也支持直接从嵌套目录启动，此时自动指令链必须容纳最具体的指令而不截断。

## Consequences

从根目录启动的会话获得更小的常驻项目文档。包工作自动获得简洁入口检查，并通过 `packages/RULE.md` 获得完整政策；当前最长的嵌套作用域也能放入显式的 64 KiB 预算。维护者必须把跨仓库 Codex 设置留在用户配置中，并把新规则放在拥有它们的最窄目录。

## Verification

`verify-doc-budgets`、`verify-agent-note-format`、翻译配对、Markdown 链接、Markdown 换行、Mermaid 解析、包路径引用与 `git diff --check` 覆盖仓库产物，包括 `packages/RULE.md`。分别在仓库根、`docs/` 与 `packages/client/` 启动新的 Codex 会话，可验证运行时指令来源与实际预算。
