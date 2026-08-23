# Agent Note: Rust capability providers behind Cordis

Status: proposed

[English](2026-08-15-rust-host-replacement.md) | 中文

## 问题

DeepSeek Harness 是以 Node 为进程根的 Cordis 插件树。产品是稳定 Service Definition 背后的可替换 Service Provider，加上三条进程外协议：SDK JSON-RPC、ACP 和 Host `/api`。该结构已经允许在不拆分 bash、PTY 或 LSP 的情况下替换一个执行世界（[portable consumers](../../implemented/architecture/2026-07-28-portable-execution-world-consumers.md)）。

一次摘掉 Node 的宿主语言替换，也会摘掉 TypeScript `apply(ctx)`、HMR、`!!js` composition 和 [`dsh-tool-cordis`](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。这些是产品扩展行为，不是宿主意外。仅替换 Provider 的原生模块——Landlock launcher（[native architecture](../../../../native/landlock-run/docs/architecture.md)）、打包的 ripgrep 和 koffi FFI——已经表明一项能力可以移动，而不必带走 composer。

仓库仍处于预发布阶段，因此磁盘格式可以改变，但 TypeScript 插件 API 和已出厂 composition 行不是为了把后端 rust 化就可以丢掉的格式。

## 提案

在现有 Service Definition 背后增加 Rust 实现，同时 Node 仍是进程根、Cordis 仍是 composer。只有一致性验证与 TypeScript Provider 对齐之后，profile 才可以把 Rust Provider 设为默认；TypeScript Provider 和每一个 `apply(ctx)` 插件仍可加载。把 TypeScript 插件翻译成 Rust，或再嵌一个 JavaScript 引擎好让 Rust 当根，都不在范围里。

### 产品拓扑

`dsh` 仍通过 Node 和 Cordis Loader 启动。Rust 代码住在 `native/dsh`，只作为普通 Cordis facade 进入插件树：facade 声明 inject，在 `ctx.effect()` 里获取 sidecar 或进程内 addon，注册已有的 `ctx` 键，把 `AbortSignal` 转成 bridge 取消，并在 dispose 时等待停稳。Consumer 继续导入 Service Definition 包。

sidecar 子进程承担需要自有进程树的文件系统、subprocess、sandbox 和 PTY 工作。文件替换、锁、JSONL 追加或 session lease 这类叶子原语，在进程跳转被测成开销之后，可以改用进程内 native addon。agent loop、prompt 组装、工具注册表和产品插件留在 Node 进程，以便 waterfall listener 保持共享对象 identity。

Agent 隔离由独立的 [worker 进程提案](2026-08-15-agent-worker-process-isolation.md) 负责。它先把完整的 TypeScript Agent composition 移入 Node 子进程；只有 Rust Provider sidecar 不满足该提案。

### 兼容性分类

P0 为每个观察到的接口记录兼容性分类，而不是对每份 JSON 文档套用字节相等。

| 接口 | 所有者 | 要求的兼容性 |
|---|---|---|
| Session 事件 envelope 与持久化 JSONL | [`dsh-session`](../../../../packages/core/session/README.md) 与 persistence provider | 规范化后的规范持久化行保持字节相同；重建、未知事件拒绝和 `ignorable: true` 在语义上保持相同 |
| SDK JSON-RPC | [`dsh-sdk-protocol`](../../../../packages/sdk/protocol/README.md) | 方法名、params、result、error、通知顺序、取消和 NDJSON framing 与两个 SDK 客户端保持兼容 |
| ACP | [`dsh-acp`](../../../../packages/acp/acp/README.md) | 协议帧与自动化行为与 ACP snapshot 语料保持兼容 |
| Host API | [`dsh-host-apiproxy`](../../../../packages/host/apiproxy/README.md) 与 Typert Remote 定义 | endpoint、具名参数、result 与 error schema、authority、unary 与 stream 行为及顺序与现有客户端保持兼容 |
| Composition | app-boot、bundle patch 与插件 Config schema | 有序 patch 替换、`disabled`、`isolate`、`!!js` 和 HMR 保持其 TypeScript Loader 含义；Rust 不变成第二套 composer |
| 产品 bridge | `dsh-bridge-protocol` | Cordis facade 与 Rust Provider 之间的版本化内部 IPC；它不是公开 SDK |

session schema 仍是 TypeScript 拥有的开放 envelope。Rust 持久化代码把 `{ type, seq, time, data, ignorable?, ...surfaceFields }` 当作通用记录。除非已有用户可见 snapshot 钉死，TypeScript 堆栈和 Node 特有的 syscall 措辞都不是兼容性承诺。

`native/dsh/contracts/` 保存带 format version 和 source digest 的生成 JSON schema、正向 fixture 和负向 fixture。TypeScript 仍是语义所有者；新鲜度检查会重新生成这些产物，并在出现 diff 时失败。

### 双向兼容约束

Rust 实现是替换品，不是目的地。每个 Rust Provider 都必须能在无残留状态下切回其 TypeScript Provider：

- **回退不留孤儿状态。** Rust 实现引入的持久化产物——session lease 文件、日志行格式、锁兄弟文件——必须能被 TypeScript 实现读取、校验和清理，或由 supervisor 在 drain-and-resume 期间显式移交。切回 TypeScript 绝不能留下无人认领的 lease，或 TypeScript 侧无法消费的格式。
- **日志格式字节对齐。** Rust 写入的 session JSONL 行必须符合 TypeScript `format.ts` 行规范和 zstd 帧格式。验收包含双向 fixture：Rust 写入的日志被 TypeScript 原样读取，反之亦然。
- **单一共享 conformance 语料。** capability conformance suite 是单一共享 fixture 集——一份 JSON 用例语料，两侧各一个 runner。Rust 与 TypeScript Provider 运行同一语料；任一方向切换后端都通过同一组 assembled snapshot。
- **仅显式回退。** 回退到 TypeScript Provider 是显式配置的操作，并以 effective backend 写入 diagnostics 报告；它绝不是隐藏 fallback。

### 产品 bridge

`dsh-bridge-protocol` 是 Rust Provider 的产品 IPC，不是迁移脚手架。公开的 SDK、ACP 和 Host 协议从不把 bridge 帧当作隧道或对外暴露。初始载体是子进程的 stdin 与 stdout，使用 `Content-Length` 分帧的 JSON；stderr 只用于诊断。在测到吞吐或分配失败并证明需要二进制 payload 扩展之前，字节块可以使用 base64。同一个 bridge 也是 worker 进程提案的 Agent worker 传输：worker 命令是 `agent` service 上的 `call` 帧，session-event 通知是 `event/invoke` payload，因此 Rust Provider 与 Agent worker 共享同一套 IPC 原语。

| 操作 | 要求的行为 |
|---|---|
| `call` / `reply` | 全双工、可重入的请求／响应，带有精确的 service、method、arguments、result 和类型化 error |
| `cancel` | 幂等地中止所拥有的请求及其全部子资源；仅当终态帧先发出时，已完成的请求才获胜 |
| `resource/open` / `resource/release` | 传递不透明 handle，所有权留在创建进程；断开连接会释放每一个仍活着的 handle |
| `stream/open` / `stream/chunk` / `stream/end` | 保持每条 stream 的顺序、终态错误或成功、有界缓冲、接收方 credit 和取消 |
| `contribution/register` / `contribution/remove` | 在一个插件 generation 下注册服务和事件 listener，并作为一项可逆 effect 一并移除 |
| `event/invoke` | 携带 serial、parallel、emit 或 waterfall 分派，以及原始事件 payload 和有作用域的注册 identity |
| `continuation/call` / `continuation/reply` | 实现一次性 waterfall `next()`，让 Node listener 可以包装 Rust Provider，或让 Rust Provider 回调 Node，而不共享对象引用 |
| `dispose` / `quiescent` | 停止新工作，按约定取消或排空已有工作，释放资源，并仅在完全停稳后确认 |

依赖共享可变对象 identity 的 parallel 事件不过桥；那些 listener 留在 Node 进程。角色对调（Rust 作进程根、Node 作 guest）只是实验室 fixture，不是产品拓扑。

### 阶段

各阶段在出口边界上顺序进行。在该阶段变绿之前，已出厂 profile 不会把 Rust Provider 设为默认。TypeScript Provider 仍留在树里。

| 阶段 | 负责 | 出口 |
|---|---|---|
| P0 契约与 ledger | Cargo workspace、生成 fixture、[迁移 ledger](../../implemented/process/2026-08-15-rust-migration-ledger.md) | 新鲜度与双向 fixture 检查通过；profile 不改变 |
| P1 产品 bridge | 分帧 IPC、生命周期、stream、resource、回调、故障处理 | 文件系统、subprocess、PTY 和 waterfall fixture 在 Node 根配对下通过；profile 不改变 |
| P2 持久化叶子 | 原子写入、文件锁、JSONL、SQLite、session lease | TypeScript coordinator 可以在 facade 后使用 Rust 存储；第二个 writer 无法获取仍被占用的 session；TypeScript 后端仍可挂载 |
| P3 执行世界 | `fs`、`subprocess` 和 `sandbox` Provider 以及同一 sidecar 中的 PTY | 已出厂 `web` 和 `headless` profile 可以把该 Rust 世界设为默认；bash、PTY 和 LSP Consumer 留在 TypeScript；TypeScript 本地 Provider 仍可挂载 |
| P4 经测量的 Provider | 仅限 Node 路径已记录成本的流式或查询后端 | chunk 顺序、重试、取消和 teardown 与该后端的 fixture 一致；不重写 spine 或产品插件 |

宿主替换计划中的 P5–P9——重实现面向模型的 spine、重写产品插件、倒置进程根、替换 web host、以及移除 Node——不在默认路径上。只有在新的 Agent Note 和「此拓扑无法满足」的测量理由下才重新考虑。

回合切换的第 1、2 步、卡住工具的排空和 HMR 留在 TypeScript。若要做第 3 步自动续跑，先在 TypeScript 里做，以免实现两遍。

### 包与 crate 对照

替换单位是 Service Provider，不是 Service Definition，也不是 Consumer。Definition、工具和 composer 留在 TypeScript。生成的 [Rust 迁移矩阵](../../../../docs/rust-migration-matrix.md) 是完整包清单；下表是替换策略。

已交付的 Rust crate，以及它们背后对应的 TypeScript：

| Rust crate | 实现 | 留下的 TypeScript | 当前载体 |
|---|---|---|---|
| `dsh-bridge-protocol` | 版本化 bridge 消息、framing、握手、生命周期 | 无——新 IPC | sidecar 及其测试使用 |
| `dsh-bridge-runtime` | stdio 连接、服务注册表、取消、dispose | 无——新 IPC | sidecar 使用 |
| `dsh-sidecar` | 原型 `fs`、`subprocess` 和 PTY 服务 | [`dsh-fs`](../../../../packages/fs/fs/README.md)、[`dsh-subprocess`](../../../../packages/subprocess/subprocess/README.md)，以及 bash / PTY / LSP Consumer | 子进程 stdio |
| `dsh-primitives` | 带品牌的字符串 id、原子文件替换、writer lock | [`dsh-brand`](../../../../packages/util/brand/README.md) 仍是仅类型 Definition；settings 与 credentials coordinator 留在 TypeScript | 仅原型；之后是进程内 addon 或 sidecar |
| `dsh-session-store` | 独占 session lease、JSONL 追加与回放 | [`dsh-session`](../../../../packages/core/session/README.md) 和 [`dsh-session-persistence`](../../../../packages/session/session-persistence/README.md) 留在 TypeScript | 仅原型 |
| [`landlock-run`](../../../../native/landlock-run/docs/architecture.md) | 现有的 C11 Landlock launcher | [`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.md) 继续调用它 | 未改变的原生辅助程序 |

计划中的 Provider 替换。每一行都把 Service Definition 包留在 TypeScript：

| TypeScript Provider | 目标 crate | 阶段 | 留下的 TypeScript Definition |
|---|---|---|---|
| [`dsh-atomic-write`](../../../../packages/util/atomic-write/README.md) | `dsh-primitives` | P2（原型） | 无——该包本身就是原语 |
| [`dsh-session-persistence-jsonl`](../../../../packages/session/session-persistence-jsonl/README.md) | `dsh-session-store` | P2（原型） | `dsh-session-persistence` |
| [`dsh-session-persistence-sqlite`](../../../../packages/session/session-persistence-sqlite/README.md) | `dsh-session-store` | P2 | `dsh-session-persistence` |
| [`dsh-settings-file`](../../../../packages/settings/settings-file/README.md) | `dsh-primitives` 负责持久化文件 | P2 | `dsh-settings` |
| [`dsh-credentials-local`](../../../../packages/credentials/credentials-local/README.md) | `dsh-primitives` 负责持久化文件 | P2 | `dsh-credentials` |
| [`dsh-attachment-local`](../../../../packages/attachment/attachment-local/README.md) | 与 `dsh-primitives` 并列的 store crate | P2 | `dsh-attachment` |
| [`dsh-spill-local`](../../../../packages/spill/spill-local/README.md) | 与 `dsh-primitives` 并列的 store crate | P2 | `dsh-spill` |
| [`dsh-fs-local`](../../../../packages/fs/fs-local/README.md)、[`dsh-fs-sandbox`](../../../../packages/fs/fs-sandbox/README.md) | `dsh-sidecar`／之后的 `dsh-execution` | P3 | `dsh-fs` |
| [`dsh-subprocess-local`](../../../../packages/subprocess/subprocess-local/README.md) | `dsh-sidecar`／之后的 `dsh-execution` | P3 | `dsh-subprocess` |
| [`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.md)、[`dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.md) | `dsh-sidecar` 加上 `landlock-run` | P3 | `dsh-sandbox` |

留在 TypeScript。除非后续有经测量的 Agent Note 打开一项，否则不计划 Rust 克隆：

| 种类 | 包 |
|---|---|
| Composer 与宿主机制 | Cordis Loader、HMR、`!!js`、`tsx` 源码启动、Typert generator／loader／registry、[`dsh-tool-cordis`](../../../../packages/extensions/tool-cordis/README.md) |
| 面向模型的 spine | `dsh-session`、`dsh-system-prompt`、`dsh-tools`、`dsh-agent`、`dsh-agent-loop`、`dsh-scope` |
| 产品插件 | approval、commands、user-questions、subagent 及进程内 driver、compaction、jobs、skill、包括 `dsh-workflow-worker-thread` 的 workflow、goal、plan、todo |
| 执行世界之上的 Consumer | `dsh-tool-fs`、`dsh-tool-bash`、`dsh-bash-local`、`dsh-terminal-bash`、`dsh-lsp-stdio`、`dsh-tool-lsp` |
| 备选执行世界 | `dsh-e2b`、`dsh-fs-e2b`、`dsh-subprocess-e2b` |
| 产品入口与客户端 | `dsh-acp`、SDK protocol／client／server、`dsh-host-apiproxy`、`dsh-host-webserver`、`apps/web`、`packages/client` |
| 仅在测量之后 | `dsh-llm-deepseek` 及其他 adapter、web fetch／search、MCP、`dsh-session-query-sqlite` |

ledger 上的 `migrated` 表示已出厂的默认 Provider 是 Rust。TypeScript Provider 包仍留在工作区，并仍可从 composition 选回。

### 候选工作队列

| 顺序 | 工作 | 退出条件 |
|---|---|---|
| 1 | 在有代表性的持久化与 live corpus 上基准测试 `dsh-session-query-sqlite`，记录 query latency、Node event-loop delay、reconciliation throughput、cancellation latency 和 resident memory | 只有测量确认显著 Node 成本或隔离要求后，才用一份 P4 Agent Note 打开 `dsh-session-index` |
| 2 | 定义 `dsh-session-index` facade 和共享 conformance corpus；TypeScript 保留 `SessionQuery` Definition、canonical session log、request semantics 和 Consumer，Rust 只拥有可丢弃的 derived database、reconciliation、FTS execution、cursor generation 和 query cancellation | Rust 与 TypeScript backend 通过相同的 search、cursor invalidation、rebuild、cancellation 和显式双向切换 case，且不改变面向模型的 snapshot |
| 3 | 判定 restartable 或 durable DAG execution 是否是产品要求；若是，则定义版本化纯数据 DAG 表示，以及完整 capability 背后的独立 Rust engine | 提案证明 deterministic scheduling、bounded concurrency、cancellation、checkpoint recovery 和由 TypeScript 负责的有序 session event，且不翻译当前 JavaScript worker，也不嵌入另一套 JavaScript runtime |
| 4 | 让 ACP、Codex、Claude Code 和 DSH SDK subagent adapter 使用 P3 Rust subprocess Provider，并测量 process-tree cleanup、bounded output、cancellation 和 adapter duplication | 只有共享 subprocess Provider 交付后仍存在 protocol-neutral supervision 重复，才提议独立 `dsh-subagent-runner`；continuable orchestration 和 Provider protocol 留在 TypeScript |
| 5 | 在考虑 Rust backend 前，用一份提案把接收 callback 和 live `Agent` 的 jobs start API 改为纯数据 job specification、owner identity、command、observation 和 recovery rule | 新 jobs 提案定义 restart、cancellation、ownership、result delivery 和 compatibility semantics，且不跨进程传递 callback 或 live object |
| Deferred | `agent-loop`、continuable subagent orchestration、当前 JavaScript workflow engine、todo 和 session projection 留在 TypeScript；只有 profiling 把 CPU 工作与 LLM 及 same-tick coordination 分离后，才评估 compaction 或 projection compute kernel | 任何 row 移动前，后续经测量的 Agent Note 必须点名未满足的产品要求、隔离出的计算和 conformance evidence |

### Ledger

[`native/dsh/migration/package-map.json`](../../../../native/dsh/migration/package-map.json) 是机器可读 ledger，[`docs/rust-migration-matrix.md`](../../../../docs/rust-migration-matrix.md) 是其生成的人类视图，由 [`scripts/gen-rust-migration-ledger.ts`](../../../../scripts/gen-rust-migration-ledger.ts) 生成。维护者编辑 [`native/dsh/migration/overrides.json`](../../../../native/dsh/migration/overrides.json)。[ledger Agent Note](../../implemented/process/2026-08-15-rust-migration-ledger.md) 负责该生成器。`removeAfter` 不是移除 Node 的门；本提案不安排删除 TypeScript 实现。

### 外部设计参考（2026-08-23）

InstantDB（`instantdb/instant`，Apache-2.0；OpenAI 2026-08-22 收购团队；完整分析见 `dsfolder/INSTANTDB-ANALYSIS-2026-08-23.md`）验证并锐化了本笔记触及的两个语义。二者都是参考形态而非待导入代码——实现顺序仍以 TypeScript 为准（先做 Step 3），Rust 重实现只在上述阶段门禁内进行。

- **幂等续传协议（Step 3；未来任何 P5 重实现）。** InstantDB 客户端 `SyncTable` 协议是可重连流上 exactly-once 重发的行业参照：每条客户端消息带客户端生成的 `client-event-id`（服务端按它去重）；每个订阅持有持久化的 `tx-id` 游标加服务端签发的 `token`；重连时客户端发 `resync-table {subscription-id, tx-id, token}`，服务端从该游标续推（见 `client/packages/core/src/SyncTable.ts` 与 `Connection.ts`）。Step 3 chunk 去重、pending marker 去重及任何 Rust 重实现必须匹配该形态：客户端生成幂等键 + 持久化游标 + 服务端按序去重。
- **派生搜索/索引投影（candidate work queue 第 2 项）。** InstantDB 在 Postgres 上跑多租户 triple store（EAV），自管列、partial index 实现唯一约束、count-min sketch 恢复 planner 统计。该模式对应 `dsh-session-index`：在权威会话日志之上做一次性派生数据库，生成 `(session_id, event_id, attr, value)` 行加生成列与索引，而不是特制查询端点；其查询引擎把形状查询编译成 SQL 计划（pg_hint_plan）——是把 `SessionQuery` 编译成针对派生库的 SQL 的先例。

## 考虑过的替代方案

**替换 Node 进程根并移除 JavaScript 运行时（此前的 P5–P9 宿主替换计划）。** 作为完成条件否决：它会收回 `apply(ctx)`、HMR、`!!js` 和 `dsh-tool-cordis`。Rust Provider 不要求那次收回。

**把 TypeScript 插件翻译成 Rust，或寻找与 Cordis 对等的 Rust crate。** 否决：declaration merging、活的 `ctx`、waterfall `next()` 和可逆 effect 是 TypeScript 宿主机制。翻译会丢掉对 identity 敏感的 listener。没有在维护的 Rust 库复现该 API。

**用 Bun、Deno 或嵌入的 V8／QuickJS 作为永久 guest，好让 Rust 当根。** 否决：那是第二套 JavaScript 运行时，不是 Provider 替换，并且这棵树的 native addon（`node-pty`、koffi、Landlock）寄宿在 Node 上。guest 只保留为实验室 inversion fixture。

**保持 bridge 为临时设施，并在 inversion 前冻结更小的 worker ABI。** 在此拓扑下否决：不计划 inversion，因此 bridge 就是 Rust Provider 的产品 IPC。仅供 guest 的 contribution 消息在生产中保持不用。

**为求完整而用 Rust 重实现 `session`、`agent-loop` 和产品插件。** 在没有测到 Node 进程成本之前否决：这些包就是扩展面。把它们搬走会迫使每个 listener 过桥，并再次制造宿主替换问题。

**只用 N-API，不要 sidecar。** 作为唯一载体否决：文件系统、subprocess、sandbox 和 PTY 需要自有进程树和崩溃隔离。在测到跳转开销之后，P2 叶子仍允许进程内 addon。

**创建按 Provider 定制的 CLI 协议。** 否决：每个包装都需要自己的取消、stream、error 和 teardown 规则。一条 bridge 给这些规则一次实现。

**只用 unary JSON-RPC，跳过 waterfall。** 否决：PTY 和 subprocess 暴露活资源，并且 Node 中间件仍须通过 `next()` 包装 Rust Provider。

**用 Rust 重写 React 客户端。** 否决：浏览器已经是 Host RPC 背后的独立进程。

## 验收标准

- P0：生成 fixture 与 ledger 配对保持新鲜度门控；profile 不改变。
- P1：Node 根下文件系统、subprocess、PTY、取消、waterfall `next()` 和 dispose 的 bridge fixture 通过；在 P3 之前，已出厂 profile 默认不加载 sidecar。
- P2：Rust 存储叶子通过专项一致性验证；session lease 拒绝第二个 writer；TypeScript persistence 后端仍可挂载；shadow 比较从不双写生产状态。
- P3：只有在组装 snapshot 通过之后，已出厂 profile 才可以把 Rust 执行世界设为默认；bash、PTY 和 LSP Consumer 不改变；TypeScript 本地 Provider 仍可挂载。
- P4 只在有记录的测量和针对该 Provider 的 facade 时发生；它不搬动 spine 或产品插件。
- `apply(ctx)`、HMR、`!!js`、Typert、`tsx` 源码启动、`dsh-tool-cordis` 以及 TypeScript SDK／ACP／Host 客户端仍是产品 API。
- 生成的包矩阵点名每一个 DSH 包，并在每个默认 Rust Provider 上给出目标 crate、fixture、placement、阶段，以及留下的 TypeScript Definition。

## 风险

- **两个语义所有者。** 手维护的 Rust 与 TypeScript schema 会漂移。P0 只允许一个 TypeScript 所有者和生成的派生物。
- **分布式 waterfall 死锁。** 跨 bridge 的嵌套 `next()` 需要可重入的帧处理和一次性 continuation 所有权。需要共享可变 identity 的 listener 留在 Node。
- **无界的 bridge 内存。** 接收方 credit、有界队列、取消优先级和进程死亡清理是协议要求。
- **Shadow 副作用。** 有状态比较使用隔离目录或一次性数据库；生产状态从不双写。
- **隔离是真空，不是检查。** 在 facade 被列入允许名单并带上自己的一致性验证套件之前，`scripts/verify-native-dsh-boundary.ts` 拒绝点名 Rust 迁移包的已出厂 composition。
- **Snapshot 锁死 TypeScript 意外。** 只有公开文本和规定顺序才是兼容性要求。
- **Session 脑裂。** lease 是独占的；第二个 writer 无法获取仍被占用的 session。仍由 Node coordinator 决定何时获取或释放该 lease。
- **双份 CI 成本。** 每个默认 Rust Provider 都仍需要 Cargo 与 Node 两套测试。
- **Bridge 僵化。** 完整消息集仍可供 facade 使用；除非 facade 真正注册 contribution，生产 Provider 应使用 `call`、`cancel`、`stream`、`resource` 和 `dispose`。
- **原生 launcher 范围。** Landlock 仍是现有的 C11 可执行文件。本提案不重写它。
