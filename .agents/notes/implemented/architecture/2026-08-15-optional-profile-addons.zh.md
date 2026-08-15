# Agent Note: 树外 profile 插件按次启动隔离

Status: implemented

[English](2026-08-15-optional-profile-addons.md) | 中文

## Problem

profile 的 include 树是一个 fail-loud 单元。任一兄弟条目失败时 `EntryGroup.update` 会拒绝，`boot` 随之销毁未完成的上下文，进程退出。这对安装自有条目（`dsh-base`、`dsh-web-app`、`dsh-headless`）是正确契约：session、LLM 或 webserver 行损坏时，不得半组装启动。

树外组合包（`dsh plugin add`）和用户层 `insert` 条目并非自包含。其中一行的语法错误、漏写 `inject`、或过期的 `defineTool` 调用，会拖垮承载其余插件的同一进程。`disabled: true` 会跳过 apply 但仍会 import 模块，因此顶层抛错仍会使启动失败。`--dump-config` 不会 import。MCP 已用 `failOnStartupError: false` 隔离外部 server；普通组合包行没有对等机制。

## Decision

**安装自有条目继续 fail-loud。插件条目仅在本进程隔离。** 若某行 id 不是由「能从 dsh 安装锚点解析的组合包」插入的，该行就是插件条目。这包括树外组合包 insert，以及用户 / home / `--patch` 的 insert。对安装自有行的按 id 覆盖仍算核心：弄坏 `llm` 或 `session` 仍会使进程失败。

`bootQuarantiningAddons` 启动组合后的树，从拒绝链中读取失败的 Loader 条目 id（以及激活审计中的名称），禁用每个失败的插件条目并重试。禁用只是内存中的 patch，不写回 `cordis.patch.yml`。下一进程会再次尝试该插件。若失败点名了非插件行，或没有点名任何插件行，则原样重新抛出。

不 fork 上游 Loader。隔离放在 app-boot，因为 profile 组合已经知道哪些组合包来自安装目录。用户 patch 的 HMR 在重应用被拒时会保留上一棵可用树，因此稍后启用仍损坏的插件不会拆掉正在运行的宿主。

`dsh plugin add` 会对每个新加入的树外组合包做 import 探测，失败时警告。add 仍然成功：若加载仍失败，宿主会隔离该行。

## Consequences

- 损坏的 multimedia（或任何其他树外）行不再阻止 `dsh web` 监听。
- `--dump-config` 仍把该插件显示为已组合且启用；隔离是启动时事实，不是组合事实。
- `pluginInventory` 把被隔离的行列为 disabled，而不是 `fiberPhase: failed`。
- import 阶段抛错已被覆盖；apply 成功后异步拒绝仍走 `installFailLoud`。
- 核心缝的 fail-loud 与 MCP 的 `failOnStartupError` 不变。

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| 在 vendored `EntryOptions` 上加 `optional` | 会 fork Loader/Include；profile 组合已经知道所有权 |
| 把插件 `name` 改写成包装插件 | 按 id 的用户覆盖会整段替换 `config`，从而剥掉包装 |
| 第二棵 include / 进程隔离 | 这是启动分类问题，不是执行世界问题，不值得加一套生命周期 |
| 失败启动后把 `disabled: true` 持久化 | 随后修好也会一直停用，直到有人改 profile patch |
| 整棵树 fail-soft | 损坏的 `session` 或 `llm` 行不得启动 |
