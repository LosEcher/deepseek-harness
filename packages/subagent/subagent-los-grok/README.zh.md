---
description: "可选的 Profile bundle，用于注册一次性 LOS Grok subagent 提供方，以委派外部运行时工作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-los-grok

[English](README.md) | 中文

## 概述

当一次性委派任务应在 LOS 的有界 Grok 运行时上执行时，把 `@deepseek-ai/dsh-subagent-los-grok` 安装进 Profile。每次运行会探测 `GET /runtimes/capabilities`，仅在 Grok 可运行且可用时调用 `POST /runtimes/grok/run`，并返回捕获的 SSE 文本或安全失败诊断。能力、进程生命周期与证据仍以 LOS 为准。Bundle 只注册休眠提供方；模型只能通过委派工具行触达它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当委派应作为父会话工作区中的一次 LOS Grok 外部运行时任务执行时，挂载本提供方。把 Bundle 安装进 Profile，可选地配置提供方行，并通过委派工具行把它暴露出去。

### 安装 Bundle

把包安装进目标 Profile，然后重启该 Profile。声明的 patch 层只注册休眠提供方，不启动任何 LOS 进程。

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-los-grok
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-los-grok
dsh --profile <name>
```

移除包后，下一次 Profile 启动会撤回提供方。安装决定 Host 可用性，而不是模型权限：模型只能通过你组合的委派工具行触达提供方。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `los-grok` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `baseUrl` | `http://127.0.0.1:8080` | LOS 网关 origin；加载时会去掉末尾斜杠 |
| `authTokenEnv` | `LOS_AUTH_TOKEN` | 提供 LOS bearer token 的环境变量 |
| `operatorTokenEnv` | `LOS_OPERATOR_TOKEN` | 提供 LOS operator token 的环境变量 |
| `timeoutMs` | `300000` | 单次运行时请求的整数上限，范围 1000–600000 |
| `outputLimitBytes` | `128000` | 捕获 SSE 文本的整数上限，范围 4096–512000 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-los-grok)是每个已接受字段及其 JSDoc 的完整来源。凭据只从命名环境变量读取，从不取自插件配置。

### 暴露工具

每个委派工具行指定一个提供方，并需要自己的 `toolName`。

```yaml
- id: tool-subagent-los-grok
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: los-grok
    toolName: subagent_los_grok
    backgroundMode: one-shot
    maxDepth: provider-managed
```

### 你会得到什么

成功运行会把捕获的 Grok 输出作为 assistant 文本返回。能力探测失败、非零退出、缺少 terminal event、HTTP 失败和超时会以带安全诊断的 `error` 结束。调用方取消会以 `aborted` 结束。HTTP 200 以及带非零退出码的 `runtime.completed` 都不会被当成任务成功。

### 失败与恢复

当 Grok 不同时满足 `implementation: runnable` 与 `available: true` 时，运行在 `POST /runtimes/grok/run` 之前 fail closed。缺少父会话 cwd 会在发布前失败。已取消的运行以 `aborted` 结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

本节说明提供方如何与 LOS 通信；完整约定见[使用本包](#use-this-package)。

### 设计概念

- **一次性 HTTP 运行时。** 每次运行先探测能力，再消费一条有界 SSE 流；没有 continuation 或 resume。
- **LOS 是权威来源。** 能力、进程退出和 terminal event 来自 LOS；DSH 不复制那套 agent loop。
- **Fail closed。** 不可用的运行时、缺少 terminal 或非零退出都是错误，而不是成功的空答案。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、提供方注册 |
| [`src/run.ts`](src/run.ts) | 能力探测、SSE 转译、结果结算 |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册休眠提供方的 Profile patch 层 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时，阅读这些页面。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md) — 服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md) — 本提供方注册到的注册表与 start API。
- [Codex subagent 提供方](../subagent-codex/README.zh.md) — 兄弟进程外产品后端。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-los-grok) — 每个已接受配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

LOS Grok 运行时把独立文本块作为一条 prompt 接收，并把父会话 cwd 作为 `workspaceRoot`。图像和其他非文本块不会进入该 prompt。

#### Token 效果

子级为独立的 LOS Grok 上下文和一轮付费。子级 token 不进入父级上下文。

#### KV Cache 效果

与父级请求缓存相互独立。复用只取决于 LOS 和 Grok 运行时。

### 父级调度与结果，间接

#### 模型看到什么

通过 `dsh-tool-subagent`，前台调用把捕获的 Grok 文本或带 stop reason 与可选安全诊断的错误交给父级。后台调用先返回 Job id；通用 job 控件稍后交付同一结果。

#### Token 效果

父级为工具结果文本或 Job id 付费。LOS SSE 帧、凭据和原始 HTTP 正文不进入父会话。

#### KV Cache 效果

在追加工具结果或 Job id 之前，父级前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时本提供方不合适。它们是当前的包约束。

- **仅一次性** — 没有 continuation、resume、pooling 或进度流。
- **没有可选的共享能力** — 共享服务会拒绝 `agentOptions`、output schema、子级 persona、工具过滤和 harness 深度强制。
- **身份验证留在命名环境变量中** — Bundle 不会签发 LOS token，也不会改写 LOS 配置。
- **没有超出 `timeoutMs` 的墙钟超时** — 更长的工作由调用方取消，取消前已改动的文件不会被恢复。
- **真实 LOS 执行由 operator 负责** — 单元测试注入 `fetch`；真实 Grok 任务需要 operator 凭据和可达网关。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
