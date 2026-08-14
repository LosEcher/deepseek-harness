# Agent Note: 以 Rust 宿主替换 Node 运行时

Status: proposed

[English](2026-08-15-rust-host-replacement.md) | 中文

## 问题

DeepSeek Harness 是一棵 Cordis 插件树，进程根是 Node。产品是稳定 Service Definition 背后可替换的 Service Provider，再加上三条进程外协议：SDK JSON-RPC、ACP（Agent Client Protocol）和 Host `/api`。这套结构已经允许整块搬走一个执行世界，而不必 fork bash、PTY 或 LSP（[可移植消费者](../../implemented/architecture/2026-07-28-portable-execution-world-consumers.md)）。它并不允许宿主进程本身离开 Node。

把整棵 TypeScript 树一次性改写成 Rust，会丢掉插件组合模型、会话日志和现有快照（snapshot）语料。只把 Service Provider 做成原生模块——Landlock 启动器（[native 架构](../../../../native/landlock-run/docs/architecture.md)）、打包的 ripgrep、koffi FFI——能改善热路径，但进程根仍是 Node，因此完不成替换。

仓库仍处于预发布：后端可以拒绝旧的磁盘格式，且 `SESSION_FORMAT_VERSION` 固定为 `0`（[会话日志版本](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)）。只有在这个窗口里，更换宿主语言还能保住同一产品身份。

## 提案

用 Rust 二进制替换 Node 宿主，同时保留浏览器客户端、Python 与 TypeScript SDK 客户端，以及现有的会话和线路 JSON。无法回放当前无密钥快照的替换是另一个 harness，不是这一个。

### 替换目标

完成意味着每条产品入口——headless、ACP，以及服务 `apps/web` 的 web 宿主——都是同一个 Rust 二进制，且用户运行时闭包中没有 Node。仓库开发工具（vitest、doc-sync（文档同步门禁）、文档网站）可以继续使用 TypeScript。

不在范围内：重写 React 客户端、在 Rust 中复刻 Cordis 的 HMR（热模块替换）、复刻 Typert、在 Rust 组合器里求值 `!!js`，以及热编译由模型写的插件（`dsh-tool-cordis`，[自指工具集](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)）。

### 冻结的跨进程约定

这些 JSON 文档在换语言后保持比特兼容。CI 检查从两个方向比对 TypeScript 类型与 Rust crate fixture（测试前置数据）。

| 约定 | 所有者 | 钉住它的东西 |
|---|---|---|
| 会话事件 | [`dsh-session`](../../../../packages/core/session/README.md) | `deriveMessages()`、持久化、UI、SDK 通知 |
| SDK JSON-RPC | [`dsh-sdk-protocol`](../../../../packages/sdk/protocol/README.md) | Python SDK、TypeScript SDK（[SDK 决策](../../implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md)） |
| ACP | [`dsh-acp`](../../../../packages/acp/acp/README.md) | 编辑器自动化和 ACP 快照 |
| Host RPC | [`dsh-host-apiproxy`](../../../../packages/host/apiproxy/README.md) | 现有 React 客户端（[GUI RPC](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)） |

组合 YAML 保留 `id`、`name`、`config`、`disabled` 和 `isolate`。`!!js` 表达式改为显式 overlay；Rust 组合器不求值 JavaScript。

### 进程根倒置

进程根没动之前，产品仍是 Node。因此替换是两个机械阶段，不是一次重写。

Node 仍是根时，Rust crate 先实现 Service Provider，再实现脊柱（`session`、`llm`、`system-prompt`、`tools`、`agent`、`agent-loop`（智能体循环））。TypeScript 包变成注册同一批 `ctx` 键的门面（[能力 seam](../../implemented/architecture/2026-06-13-capability-seams.md)）。

随后 Rust `dsh-runtime` 成为根。它直接装入 crate，说冻结的线路约定，并可以为尚未迁移的插件 spawn 一个有截止日期的 JS guest。headless、ACP 和 SDK 服务器先走。web 宿主在 Host RPC 按同一 `/api` 约定重实现之后再走。

### 替换分层

分层是顺序的。未达到[验收标准](#验收标准)中该层出口的层，不得开始下一层。

| 层 | 拥有 | 出口 |
|---|---|---|
| L0 约定 crate | `native/dsh` workspace：`dsh-session`、`dsh-llm-types`、`dsh-sdk-wire`、`dsh-host-wire`、`dsh-acp-wire`、`dsh-compose` | 双向 JSON golden 在漂移时变红；任何产品 profile 都不改变行为 |
| L1 能力 crate | 现有 CLI 约定下的 Landlock 启动器；作为同一执行世界的 `fs` / `subprocess` / `sandbox`；会话持久化与查询 SQLite | 出厂 `web` 和 `headless` profile 默认使用 Rust Provider；bash、PTY 和 LSP 包保持不变 |
| L2 脊柱 crate | [`dsh-agent-spine-demo`](../../../../packages/examples/agent-spine-demo/README.md) 中的树，顺序为：会话存储与 `deriveMessages()`、DeepSeek 适配器、system-prompt、tools 与 `tools/*` waterfall（瀑布式事件）、agent 注册表与 inbox、`agent-loop` | 具名 headless 快照在 Rust 循环与 TypeScript 循环之间逐字节相同 |
| L3 倒置进程根 | `dsh-runtime` 提供 headless、ACP 和 SDK JSON-RPC；不加载 HMR、Typert 或 `dsh-tool-cordis` | 这三条入口作为 Rust 二进制运行；ACP 快照通过；Python SDK 可对其执行 `session/prompt` |
| L4 其余 base 行与 web 宿主 | settings、credentials、approval、commands、compaction、subagent、web/MCP、workflow/goal/plan/todo，然后是 Host RPC 加上静态 `apps/web` dist | `dsh --profile web` 从 Rust 宿主提供现有前端 |
| L5 从产品中移除 Node | 删除 JS guest；从发布物和用户运行时文档中去掉 Node | 快照与组装 e2e 作业只调用 Rust 宿主 |

L1 优先采用 Landlock 打包风格的 argv/exec 二进制（[native/](../../../../native/README.md)），直到测得的延迟要求迫使使用同进程 addon。依赖 Node ABI 的 addon 活不过 L5。

`fs` 与 `subprocess` 成对搬迁。容器和 microVM 不是 `ctx.sandbox` 的 backend（[沙箱决策](../../implemented/feature/2026-07-06-sandbox.md)）。

### 插件模型

官方插件是编进二进制的 Rust crate。组合仍是一张 YAML 表。第三方 `dylib` 插件推迟到官方集合完成之后。

Rust 运行时用显式 trait 实现服务注册、`inject` 就绪、可逆 effect，以及 waterfall/serial/parallel 分发。它不复刻 TypeScript 声明合并或 HMR。

`dsh-tool-cordis` 热挂载在 L3 丢掉。之后的 WASM 或 DSL 插件宿主是新提案，不是本提案的要求。

Typert 不迁。Rust 宿主上的 Host RPC 使用冻结的 `/api` JSON，而不是类型图生成器。

### 清单

替换实现并保留 Service Definition：`fs` / `fs-local` / `fs-sandbox`、`subprocess` / `subprocess-local`、`sandbox` / `sandbox-local` / `sandbox-windows-acl`、会话持久化 JSONL 与 SQLite、`session-query-sqlite`、`llm-deepseek` 及后续适配器、web fetch/search、`attachment-local`、`spill-local`、`settings-file`、`credentials-local`。

按相同语义重实现：`session`、`system-prompt`、`tools`、`agent`、`agent-loop`、`scope`、`approval`、`commands`、`user-questions`、`subagent` 及进程内 Provider、`compaction`、`jobs`、`skill`（技能）、`host-apiproxy`、`webserver`、`frontend-static`。

不迁：HMR、Typert、`!!js`、`dsh-tool-cordis` 热挂载、`tsx` 源码启动、Node `workflow-worker-thread` 引擎（该行迁移时换成原生或独立进程引擎）。

永久留在 TypeScript 一侧：`apps/web` 与 `packages/client`、Python 与 TypeScript SDK 客户端、文档网站，以及已经说冻结线路约定的快照录制器。

## 考虑过的替代方案

**一次重写 Cordis、循环和 web 客户端。** 否决：插件树、会话重建和快照语料就是产品。从零开始的 Rust harness 会立刻分叉身份。

**在原生 Service Provider 之后停住（以 L1 为终点）。** 否决：那就是当前的 Landlock/ripgrep/koffi 模式。它永远不会把 Node 从进程根拿走。

**永久嵌入 JavaScript 引擎，让 TypeScript 插件继续加载。** 作为完成条件被否决：永久 guest 是双运行时，不是替换。有截止日期的 guest 只允许用到 L4。

**在 Rust 中复刻 Cordis 声明合并和 HMR。** 否决：那些是 TypeScript 宿主机制。替换保留插件思想（服务、inject、effect、waterfall），丢掉 TypeScript 特有的机械装置。

**把容器或 microVM 当作 `ctx.sandbox` 的 backend。** 被现有沙箱决策否决：那些替换的是 `fs` 与 `subprocess` 执行世界，不是同一世界的约束运行器。

**用 Rust 重写 React 客户端。** 否决：浏览器已经是 Host RPC 后面的独立进程。替换它是另一个产品。

## 验收标准

- L0：`native/dsh` crate 存在；若 TypeScript 的会话/SDK/ACP/Host JSON fixture 与 crate golden 任一方向不一致，CI 检查失败；任何产品 profile 都不改变行为。
- L1：出厂 `web` 和 `headless` profile 默认使用 Rust 文件系统、subprocess 和 sandbox Provider；现有 `fs`、sandbox 和 `partial-landlock` 测试与快照通过；bash、PTY 和 LSP 包不变。
- L2：`examples/headless-agent` 的 `headless-profile` 以及至少一条 tool 快照，在 Rust 循环与 TypeScript 循环之间产生逐字节相同的会话日志；取消、drain、恢复和空 turn 拒绝一致。
- L3：headless、ACP 和 SDK 入口作为 `dsh-runtime` 运行；现有 ACP 快照通过；Python SDK 可对该二进制执行 `session/prompt`。
- L4：`dsh --profile web` 从 Rust 宿主提供现有 `apps/web` dist；现有 web e2e 套件对该宿主通过，且不要求重写前端。
- L5：产品文档和发布物没有 Node 运行时依赖；JS guest 不存在；快照与组装 e2e 作业只调用 Rust 宿主。

## 风险

- **两个 harness。** 若 crate JSON 与 TypeScript 类型漂移，快照会在一个宿主上通过、在另一个上失败。L0 双向 golden 是控制手段；该检查为红时不得进入下一层。
- **快照锁死 TypeScript 意外行为。** 有些 fixture 可能编码了 Node 特有的时序或错误字符串。仅当该字符串不是用户可见的产品文本时才改 fixture；否则 Rust 宿主必须发出相同文本。
- **插件作者失去 TypeScript `apply(ctx)`。** 为完成替换而接受。官方插件迁为 crate。树外 TypeScript 插件在 L5 之前需要 guest，之后另立 dylib/WASM 提案。
- **丢掉 `dsh-tool-cordis` 等于去掉自修改。** 在 L3 接受。重新引入需要可沙箱的插件格式，而不是在产品二进制里跑 rustc。
- **同进程原生 addon（napi）。** 在测得的延迟要求迫使使用同进程 addon 之前，优先采用 Landlock 打包风格的 argv/exec 二进制。addon 会把 Node ABI 带进本提案正要删除的宿主。
- **JS guest 变成永久的。** L5 禁止随产品发布它。仍然需要 guest 的层就还没做完。
