# Agent Note: Unquoted `!!js` ternaries collapse into YAML mappings

Status: implemented

[English](2026-08-14-quoted-js-expr-ternaries.md) | 中文

## Problem

当 profile 的 MCP 行使用未加引号的三元表达式（例如 `Authorization: !!js process.env.K ? \`Bearer ${process.env.K}\` : undefined`）时，整棵插件树会在启动时失败。`!!js` 是 YAML 标量标签；未加引号的 `?` / `:` 是 mapping 语法，于是 js-yaml 把表达式节点存成对象键 `[object Object]`，标头值从未被插值。`@deepseek-ai/dsh-mcp-client` 随后拒绝 `headers.Authorization` 这个 mapping，Include 回滚整棵子树，而 `dsh --dump-config` 仍然成功，因为它不求值 `!!js`。`failOnStartupError: false` 帮不上忙：该标志只覆盖连接失败，不覆盖配置 schema 校验。

## Decision

补丁应用之后，Include 遍历组合后的树（`assertJsExprTree`），若任何 mapping 使用键 `[object Object]` 则抛错。诊断会点名条目，并提示作者把整个标量加引号（`key: !!js "cond ? a : b"`）。`dsh --dump-config` 对组合后的列表做同样的遍历，因此 daemon 预检会在进程启动前失败。

单层解析保持宽松：后续 overlay 可以替换有问题的 bundle 行，只判断组合后的树。

## Alternatives considered

**在单层解析时失败。** 会拒绝一个已被后续 overlay 修好的 bundle，并让本来能工作的 profile 在每一层都改完之前无法加载。

**让 js-yaml 把 `!!js` 行的剩余部分当成标量。** 与 YAML 分词对抗；`??` 和 `||` 本来就可以不加引号，只有 `?` / `:` 是 mapping 语法。

**在 Include 内吞掉单个子条目的 ValidationError。** 会掩盖配置错误。连接阶段的 `failOnStartupError` 仍然是“服务器可达但宕机”的隔离点。

## Consequences

加了引号的三元表达式、`??` 和 `||` 行为不变。组合后的树若仍带有塌缩后的 mapping，现在会在 dump-config 和启动时以同一条消息失败，而不再是 schemastery 打印的 `{[object Object]: ...}`。

## Testing

`packages/boot/app-boot/tests/config-dump.spec.ts` 拒绝组合后未加引号的三元表达式，并接受替换该行的 overlay。`packages/boot/app-boot/tests/user-patches.spec.ts` 在 `boot()` 上拒绝同一份 YAML。
