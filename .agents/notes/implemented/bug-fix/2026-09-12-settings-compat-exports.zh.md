# Agent Note: Restore settingsNamespace and installSettingsSection exports

Status: implemented

[English](2026-09-12-settings-compat-exports.md) | 中文

## Problem

第三方 profile 插件从 `@deepseek-ai/dsh-settings` 导入 `settingsNamespace` 和 `installSettingsSection`。上游 0.1.5-rc.2 把这套接线搬到了 `SettingsProvider.installSection`，并不再导出这两个助手，因此对着本树做 source-launch 时无法导入 `dsh-llm-fallbacks`、`dsh-session-pin` 和 `dsh-tool-ocr`。

## Decision

把 `settingsNamespace` 作为现有解析器上的公开 brand 助手重新导出，并把 `installSettingsSection` 做成调用 `ctx.settings.installSection` 的 inject 包装。第一方插件继续用方法；树外插件继续用它们已经导入的名字。

## Alternatives considered

**禁用失败的 profile 插件。** 否决，因为那是操作者已安装的界面，不是本树的配置错误。

**让每个插件迁到 `installSection`。** 对后续是对的，但不能恢复当前已坏的 web profile。

## Consequences

仍导入 0.1.0 助手名的 profile 可以在 0.1.5-rc.2 上加载。新的第一方代码应继续调用 `SettingsProvider.installSection`。
