# Agent Note: 配置生效目录与策略包

Status: proposed

[English](2026-09-04-config-effect-and-policy-pack.md) | 中文

## Problem

正在运行的 dsh 已经是一棵组合后的插件树：先 bundle，再 profile 的 `cordis.patch.yml`，再 home patch，最后 `--patch`。生成的[配置目录](../../../docs/config-catalog.md)是每块 `config:` 的部署轴参考。操作者仍无法从该目录或 `--dump-config` 回答三个问题：

1. 这个键改完之后必须刷新什么（HMR、进程重启、新会话、页面刷新）？
2. overlay 可以只改嵌套字段，还是必须重写整行 `config`？
3. 哪些审批、sandbox、超时、提醒、MCP 过滤旋钮是同一套策略，哪些是彼此独立的插件行？

这些答案散落在注释、skill 和 postmortem 0002（`!!js` 写在错误的元数据槽里被求值）。整行替换是已文档化的 loader 契约（[architecture.md](../../../docs/architecture.md) 的 Profiles and bundles；[dsh-base patch](../../../packages/bundle/base/cordis.patch.yml) 文件头）。它防止 web / headless 的模式专用行被静默合并，也是 MCP overlay 漏掉 `serverName`、拖垮整树的常见路径。`toolAllow` / `toolDeny` / `descriptionMaxLength` 已在 `@deepseek-ai/dsh-mcp-client` 的源码和测试中存在，生成目录的粘贴块里仍没有。`@deepseek-ai/dsh-tool-call-timeout-policy` 包装 `tools/execute`，没有编入目录的 config；预算在各工具行上（`timeoutMs`、`searchTimeoutMs`）。权限已有一张表（`dsh-permission-presets`），经 `sandbox-policy` 和 `approval` 写穿。没有一份把单个策略对象编译到这些已交付行上的编写文档，也没有 fixture 套件断言「这个包允许或拒绝这次调用」。

本 note 冻结 schema，以及它们到已交付包的映射。本次不改 loader 行为。

## Proposal

交付两份附加契约，都是现有组合模型的投影：

- **配置生效目录** — 每个编入目录的配置键声明一个生效类。`--dump-config` 打印它。后续门禁在文档或 skill 的声称与该类矛盾时失败。
- **策略包** — 操作者编辑的一份 YAML。编译器（不是第二运行时权威）把它展开成针对 `dsh-base` 已交付行的按 id 覆盖。配置目录仍是部署轴。

不要再加一棵平行配置树。不要把 drain/resume 状态机表写进本 note；那仍由 agent loop 的后续提案拥有。

### 范围

本提案覆盖：

- 生效类，以及它们如何挂到生成目录
- 与整行替换兼容的 overlay 合并规则
- `!!js` 求值面
- 策略包 schema，以及它在 `packages/bundle/base/cordis.patch.yml` 中的编译目标
- 从文档和目录新鲜度开始的分阶段验收

### 非目标

- 在本提案中改 Cordis Loader、HMR 或隔离。
- Starlark 或 CEL 策略 DSL。
- 把 drain/resume、工具暴露位域、或外部 SQ/EQ 协议放进策略包。
- 对 base patch 文件头禁止放进 `dsh-base` 的模式专用行做深合并。

### 配置生效类

每个编入目录的键（包括生成器已与 schemastery 交叉核对的嵌套键）恰好带一个类：

| Class | Meaning | Typical owner |
|---|---|---|
| `hot` | 同一进程、同一 fiber；仅 config 的 HMR 或 settings 文档使之生效 | `dsh-settings-file` 各节、仅 config 行的用户 patch HMR |
| `restart` | 必须重启宿主进程；ESM 模块身份不会重载 | host 插件 `name`、bundle 增删、`inject` 图 |
| `new-session` | 活树可能已是 `fiberPhase: active`；面向模型的工具 schema 和 prompt 组装按会话快照 | MCP 工具列表、`dsh-tools` 的 `mode`、system-prompt 的 `toolOrder` |
| `page-refresh` | 客户端半包或 slot 注册；刷新网页，不要重启宿主 | 从 link 安装 serve 的 `dsh.client` 产物 |
| `boot-quarantine` | 失败只隔离本进程的插件行；安装自有行仍使启动失败 | 树外 insert，见[可选 profile 插件](../../implemented/architecture/2026-08-15-optional-profile-addons.md) |

规则：

- 一行可以在不同键上混用类（若插件会重应用 config，则 `mcp-client.toolCallTimeoutMs` 是 `hot`；`mcp-client.command` 是 `restart`，因为它会重拉子进程）。目录按键列类，不按包列类。
- `new-session` 不能代替 `restart`。RPC `pluginInventory/list` 仍为 `active`，不能证明已有会话看见了新的工具 schema。
- `boot-quarantine` 是失败类，不是刷新类。`--dump-config` 仍显示组合后的启用行；隔离是启动时事实。

### 目录扩展

扩展 `scripts/gen-config-catalog.ts`，使每段粘贴的键带 `@effect` JSDoc 标签（或生成器读取的 schemastery meta 字段）。某个经 schema 校验的键没有类，或类不是上面五个名字之一时，`pnpm run verify-config-catalog` 失败。

`--dump-config` 为每个打印出的键加注释（或并列 map）。提到刷新行为的 skill 和 cookbook 必须点名该类；后续 doc-sync 检查可以对生成表核对 "restart" / "HMR" 声称。

在生成器落地之前，本 note 的对照表是策略相关行的拟定分配。

### Overlay 合并

继续按行 id 最后写入者生效。把按 id 覆盖的*载荷*从不透明整对象替换改成按 schema 应用：

1. overlay 点名行 `id`。
2. 对 overlay `config` 中出现的每个键，loader 在该包的 schemastery schema 上查找该键。
3. schema 标了 `merge: replace` 的对象值键（argv 数组、overlay 打算换新表时的 `presets` map）整段替换。
4. schema 标了 `merge: deep` 的对象值键（典型嵌套选项对象）深合并。
5. overlay 未出现的键保持上一层所写。
6. 应用后仍缺 required 键则校验失败 — 除非 overlay 替换了内含这些键的 `merge: replace` 对象，否则不必重述它们。

`dsh plugin patch --from-dump <id>`（CLI，后续阶段）打印整行 overlay，供仍想沿用今天复制粘贴行为的操作者。

这不会*跨*模式 bundle 合并。web 与 headless 取值不同的字段仍不得放进 `dsh-base`；各模式 bundle 重述该行的完整配置，与 base patch 文件头的既有要求一致。

### `!!js` 求值面

Postmortem 0002 与 include 入门已经把 `!!js` 限制在 config 标量和 `disabled`。本提案把它做成 schema 事实：

- 仅当目录/schema 标记 `expr: true` 时，该键才可写表达式。
- 除 `disabled` 以外的行元数据里出现 `!!js` 是加载错误。
- 本该是标量表达式、却被 YAML 解析成 mapping 的未加引号写法，仍是加载错误（当前失败模式）；每个使用三元的 `expr: true` 键，目录 JSDoc 必须给出加引号的例子。

`dsh-base` 中已交付的 `expr: true` 键（非穷尽，来自 patch 文件）：`sandbox-policy.mode`、`sandbox-policy.workspaceRoot`、`bash-sandbox.disabled`、`pwsh-sandbox.disabled`、`approval.policy`、`session-persistence-jsonl.root`，以及若干 `disabled:` 元数据旗标。

### 策略包

策略包是带冻结 `$schema` id 的 YAML 文件。它是**编写输入**。编译器发出普通 patch 行。运行时以下点名的插件仍是权威；agent loop 不得读取该包。

```yaml
# $schema: https://deepseek-ai.github.io/deepseek-harness/schemas/policy-pack/v1.json
version: 1
approval:
  policy: ask          # maps to row id approval (dsh-user-approval)
sandbox:
  mode: workspace-write  # maps to row id sandbox-policy
permission:
  defaultPreset: workspace-write  # maps to row id permission
reminders:
  thresholds: [3, 5, 8]           # maps to row id repeat-tool-reminder
  argumentsPreviewChars: 500
timeouts:
  # Compile-time patches of rows that already declare timeoutMs / searchTimeoutMs.
  # Does not add config to dsh-tool-call-timeout-policy (that plugin has none).
  bashSandboxMs: 60000            # row id bash-sandbox
  webSearchMs: 60000              # row id tool-web.searchTimeoutMs
mcp:
  - serverName: context7          # matches an existing mcp-client row
    toolAllow: [resolve-library-id]
    descriptionMaxLength: 200
```

编译规则：

- 未知包键失败。无法映射到已编入目录的插件键的包键失败。
- `mcp[]` 条目按 `serverName` 覆盖已经插入的 `dsh-mcp-client` 行；它们不插入 server。插入 server 仍是 overlay 的 `insert`。
- 空的 `toolAllow` 仍表示「放行全部」（已交付的 mcp-client 契约）。`toolDeny` 优先。
- 当 `permission.defaultPreset` 存在时，`approval.policy` 与 `sandbox.mode` 必须与该预设一致；不一致则编译失败，而不是让两个旋钮漂移（今天 `DSH_PERMISSION_MODE` 在 base patch 里同时写进 `sandbox-policy.mode` 和 `approval.policy`）。
- fixture 与包放在一起：每条 fixture 点名一次工具调用（名称 + 规范参数）以及期望的 pre-execute 决定（`allow` / `deny` / `ask`）。套件驱动已交付的 approval + sandbox-policy + repeat-reminder 插件，而不是 mock 解释器。

### 分阶段

1. **本 note** — schema、对照表、被拒替代。无运行时变更。
2. **目录新鲜度** — 给策略相关包加 `@effect`（以及随后的 `expr` / `merge`）；重新生成 config-catalog；在 `--dump-config` 上打印类。把 `toolAllow` / `toolDeny` / `descriptionMaxLength` 补进 mcp-client 目录粘贴（源码里已有）。
3. **Overlay 应用** — 按 schema 的键级应用，默认「省略即保留」；argv 以及 overlay 重述的 map 使用 `merge: replace`。
4. **策略包编译器** — `dsh policy apply --file pack.yml --profile web` 写入或打印 patch。fixture 进 CI。
5. **后续，不属于本包** — drain/resume 决策表；工具暴露预算；bundle 的 `trust` 字段（隔离已按安装锚点分类）。

## Inventory against shipped rows

`dsh-base` 中策略相关行的拟定生效类。其余目录包在生成器那一轮获得类；此处不列。

| Row id | Package | Keys in play | Proposed effect | Pack mapping |
|---|---|---|---|---|
| `approval` | `dsh-user-approval` | `policy` | 若会重应用则为 `hot`；否则 `restart` | `approval.policy` |
| `sandbox-policy` | `dsh-sandbox-policy` | `mode`, `workspaceRoot` | `new-session`（会话 cwd/mode） | `sandbox.mode` |
| `permission` | `dsh-permission-presets` | `presets`, `defaultPreset` | `new-session` | `permission.defaultPreset` |
| `timeout-policy` | `dsh-tool-call-timeout-policy` | *（未编入目录）* | n/a | 不是包键 |
| `bash-sandbox` | `dsh-bash-sandbox` | `timeoutMs` | `hot` | `timeouts.bashSandboxMs` |
| `tool-web` | `dsh-tool-web` | `searchTimeoutMs`, `fetch` | fetch 可见性为 `new-session`；超时为 `hot` | `timeouts.webSearchMs` |
| `repeat-tool-reminder` | `dsh-repeat-tool-reminder` | `thresholds`, `include`, `exclude`, `argumentsPreviewChars` | `hot` | `reminders.*` |
| `tools` | `dsh-tools` | `mode`, `maxParallelSubCalls` | `new-session` | 不进包（呈现，不是策略） |
| `agent-loop` | `dsh-agent-loop` | `maxParallelToolCalls`, `agents` | `agents` 为 `restart`；若存在重应用则上限为 `hot` | 不进包 |
| `mcp-client` rows | `dsh-mcp-client` | `serverName`, `command`/`url`, `toolAllow`, `toolDeny`, `descriptionMaxLength`, `failOnStartupError`, `toolCallTimeoutMs` | 传输身份为 `restart`；allow/deny/description 为 `new-session`；超时为 `hot` | 按 `serverName` 的 `mcp[]` |
| `session-query-sqlite` | `dsh-session-query-sqlite` | `openAt`, `path` | `restart` | 不进包 |
| `hmr` | `cordis-plugin-hmr` | `root` | `restart` | 不进包 |

`dsh-tools.mode` 留在包外，因为它改变的是模型呈现（`native` / `code` / `both`），不是允许/拒绝。后续的工具暴露提案可以引用本对照表。

## Alternatives considered

**把策略包做成 agent loop 读取的新 Cordis 插件。** 被拒：目录会同时有审批和 sandbox 的两份权威。编译成行能让[配置目录](../../../docs/config-catalog.md)保持唯一部署轴，并让 `--dump-config` 仍是启动真相。

**默认对每个 overlay `config` 对象深合并。** 被拒：base patch 文件头的存在，就是为了不让 web 与 headless 静默拼上模式专用键。schema 标记的 `merge: replace` 加上「省略即保留」维持这一拆分。

**只把生效类写进 skill 或 cookbook。** 被拒：skill 会漂；目录已经生成并有新鲜度门禁。没有生成器的生效类就是当前失败模式。

**用 Starlark（或 CEL）代替冻结的 YAML 包。** 本阶段被拒：解析期例子有价值（Codex execpolicy），但 DSH 已有 schemastery 和 fixture 测试。DSL 是给今天编辑 `cordis.patch.yml` 的操作者的一门新语言。仅当 fixture 无法表达所需谓词时再议。

**给 timeout-policy 增加默认 `timeoutMs` config。** 推迟：该插件是覆盖每个工具已声明预算的 execute 包装。再发明一个默认值会分叉预算所有者。包去覆盖已经声明毫秒数的行。

**把 drain/resume 放进策略包。** 本 note 被拒：drain 是 loop 语义，需要由 fixture 拥有的状态表，而不是一份可能暗示「持久状态授权自动续跑」的操作者 YAML（2026-06-20 已拒绝截断中断回合，目标自动续跑同样被拒）。

## Acceptance criteria

- 本三件套是拥有该提案的记录。实现 PR 在同一变更中更新它。
- 阶段 2：对照表中每个策略相关的目录键都有 `@effect`（或 schema meta）类；缺类时 `verify-config-catalog` 失败；mcp-client 过滤键出现在生成粘贴中。
- 阶段 2：这些键的 `--dump-config` 输出包含该类。
- 阶段 3：只设置 mcp-client 行 `toolAllow` 的 overlay 保留上一层的 `serverName` 和 `transport`；fixture 证明对嵌套对象做 `merge: replace` 后仍缺 required 键时会 fail loud。
- 阶段 4：对上文示例包运行 `dsh policy apply`，产生针对 `approval`、`sandbox-policy`、`permission`、`repeat-tool-reminder` 以及一个具名 mcp-client 行的 patch；当 pack/fixture 对与已交付的 pre-execute 行为不一致时，fixture 目录使 CI 失败。
- 本提案任一阶段都不从 `packages/core/agent-loop` 读取该包。

## Risks

- 把 `restart` 键误标成 `hot`，会教操作者跳过必要的重启。未打标签的键在生成器里必须默认 `restart`（fail closed），不能默认 `hot`。
- 按 schema 合并可能藏起操作者本想清空的键。清空必须按该键 schema 显式写 null/empty；编译器和 overlay 文档必须写明。
- 把包编译进 profile patch、同时又手改同一批行 id，会 last-write-win 并令人意外。`dsh policy apply` 必须标记生成行（注释或 `patched by policy-pack`），并在没有 `--force` 时拒绝覆盖更新的手写 patch。
- 生效类描述的是预期刷新，不是新的 HMR 实现。标了 `hot` 但插件不会重应用的键仍需重启；目录 JSDoc 不得声称插件没有的活行为。
- 本提案有意把 drain/resume、工具暴露预算、bundle trust 字段留给后续 note，使第一次实现能停在目录 + overlay + 编译成行。
