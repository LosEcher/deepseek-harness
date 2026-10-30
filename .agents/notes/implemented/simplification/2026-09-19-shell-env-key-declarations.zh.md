# Agent Note: 让 shell 环境声明只负责键所有权

Status: implemented

[English](2026-09-19-shell-env-key-declarations.md) | 中文

## 问题

[shell 环境注册表](../../../../packages/shell/shell-env/src/index.ts) 要求每个声明变量提供描述，并暴露 `list()` 枚举它。运行时收集仅使用贡献方身份、声明键和解析后的值。[Bash](../../../../packages/shell/tool-bash/src/index.ts) 与 [PowerShell](../../../../packages/shell/tool-pwsh/src/index.ts) 调用 `collect`；[Web 组合包](../../../../packages/bundle/web-app/src/index.ts) 贡献 `DSH_WEB_URL`。搜索未发现 `list()` 的固定生产调用方或其描述的消费方。

但该方法可通过 [Cordis 检查提供方](../../../../packages/extensions/tool-cordis/src/providers.ts) 发现，因此这是显式 API 收缩，而非删除不可达代码。[最初的身份与日志位置记录](../../archived/feature/2026-07-10-agent-session-identity-and-log-location.md) 预期它会服务于诊断以及未来提示/UI 消费方。当前 TODO 与 [README 限制](../../../../packages/shell/shell-env/README.zh.md) 仍描述一个未包含内置变量的不完整目录。

## 决定

贡献方声明现在是显式只读键集合（`keys: readonly DshEnvironmentKey[]`）。描述对象、`BashEnvVariable`、`BashEnvVariableInfo`、`list()`、仅针对描述的校验与完整目录 TODO 均已删除；Web 贡献方、README 配对与生成的服务/类型声明随之更新。同一贡献方内重复声明同一个键会被拒绝。

保留 `register`、`collect`、保留键、所有权冲突、拒绝未声明输出、确定性的环境输出和 effect 释放。[PowerShell 对齐参考](../../../../packages/shell/shell-env/README.zh.md) 继续拥有共享注册表及两个 shell 消费方。提案删除一个公共方法、两个元数据类型及其校验/枚举测试；在少量键成员判定适配前，已定位可删除约 32 行源码。

## 考虑过的替代方案

**补完诊断目录。** 这会在没有明确当前产品需求的情况下增加内置元数据及消费能力。提案选择放弃声明式环境描述和枚举；实际 shell 环境值仍可通过执行获得。

**删除 `list()` 后保留描述。** 否决，因为描述将没有剩余读取方，却仍给每个贡献方增加负担。键所有权声明应独立于展示元数据保留。

## 验证

- 删除前重新检查了固定调用方、记录、通用检查与当前产品要求；没有诊断消费方需要该 API，因此删除。
- 贡献方声明键而无需描述对象。重复名称、保留键、跨贡献方冲突、未声明输出及释放保持原有行为。
- Bash 与 PowerShell 获得等价的环境映射，包括 Web URL 和 Session 身份；不改变密钥处理或继承环境策略。
- 注册表、Web 贡献方与 shell 集成测试覆盖本次改动；检查目录已重新生成，两个 README 已更新，typecheck、doc-sync 与 lint 通过。

## 后果

模型编写的插件与外部插件已经能够发现和调用 `list()`。它们会失去不执行解析器的枚举能力，并需要修改贡献方声明。只有预期的诊断能力仍无归属时，这种稳定前 API 损失才可接受；不能将 `collect()` 宣称为等价诊断替代。
