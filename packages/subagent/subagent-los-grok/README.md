# @deepseek-ai/dsh-subagent-los-grok

English | [中文](README.zh.md)

This optional provider registers `los-grok` on `ctx.subagents`. Each accepted one-shot run first checks `GET /runtimes/capabilities`, then invokes `POST /runtimes/grok/run` and translates the bounded SSE lifecycle into the shared DSH `SubagentResult` contract.

The provider fails closed when Grok is not both `implementation: runnable` and `available: true`. It validates the parent session workspace, carries operator credentials only from named environment variables, bounds output, and maps cancellation, timeout, non-zero exit, and missing terminal events to an error or aborted result. It does not treat an HTTP 200 or a `runtime.completed` event with a non-zero exit code as task success.

Install it into a profile and restart that profile:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-los-grok
```

The default configuration is:

```yaml
- id: subagent-los-grok
  name: '@deepseek-ai/dsh-subagent-los-grok'
  config:
    baseUrl: http://127.0.0.1:8080
    authTokenEnv: LOS_AUTH_TOKEN
    operatorTokenEnv: LOS_OPERATOR_TOKEN
```

The package is a transport adapter, not a second DSH agent loop. LOS remains authoritative for runtime capability, process lifecycle, bounded output, and external-runtime evidence. A future durable resume protocol must add an explicit contract; this provider currently advertises one-shot semantics only.
