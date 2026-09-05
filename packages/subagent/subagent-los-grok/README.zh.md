# @deepseek-ai/dsh-subagent-los-grok

[English](README.md) | 中文

这个可选 provider 在 `ctx.subagents` 注册 `los-grok`。每次 one-shot 任务先调用 `GET /runtimes/capabilities`，确认 Grok 同时满足 `implementation: runnable` 与 `available: true`，再调用 `POST /runtimes/grok/run`，把有界 SSE 生命周期转换为 DSH 的 `SubagentResult`。

能力探测不通过时 provider fail closed。它校验父 Session 工作目录，只从命名环境变量读取 operator 凭据，限制输出，并把取消、超时、非零退出和缺少 terminal event 映射为 error 或 aborted。HTTP 200 或非零退出的 `runtime.completed` 都不会被当成任务成功。

安装到 profile 后需要重启 profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-los-grok
```

默认配置：

```yaml
- id: subagent-los-grok
  name: '@deepseek-ai/dsh-subagent-los-grok'
  config:
    baseUrl: http://127.0.0.1:8080
    authTokenEnv: LOS_AUTH_TOKEN
    operatorTokenEnv: LOS_OPERATOR_TOKEN
```

这个包只是传输适配器，不创建第二套 DSH agent loop。runtime capability、进程生命周期、有界输出和 external-runtime 证据仍以 LOS 为准。当前只实现 one-shot；如果需要可靠 resume，必须先增加明确的协议契约。
