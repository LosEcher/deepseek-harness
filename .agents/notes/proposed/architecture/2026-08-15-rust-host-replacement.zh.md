# Agent Note: 以 Rust 宿主替换 Node 运行时

Status: proposed

[English](2026-08-15-rust-host-replacement.md) | 中文

## 问题

DeepSeek Harness 是一棵 Cordis 插件树，进程根是 Node。产品由稳定 Service Definition 背后的可替换 Service Provider，以及三条进程外协议组成：SDK JSON-RPC、ACP（Agent Client Protocol）和 Host `/api`。这套结构已经允许整块迁移一个执行世界，而不必派生 bash、PTY 或 LSP（[可移植 Consumer](../../implemented/architecture/2026-07-28-portable-execution-world-consumers.md)）。它并不允许宿主进程本身离开 Node。

把整棵 TypeScript 树一次性改写成 Rust，会丢掉插件组合模型、会话日志和现有快照语料。只把 Service Provider 做成原生模块，包括 Landlock 启动器（[native 架构](../../../../native/landlock-run/docs/architecture.md)）、打包的 ripgrep 和 koffi FFI，能改善个别路径，但进程根仍是 Node，因此完不成替换。

仓库仍处于预发布：后端可以拒绝旧的磁盘格式，且 `SESSION_FORMAT_VERSION` 固定为 `0`（[会话日志版本](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)）。这个窗口允许更换宿主语言，而不承诺兼容每个中间实现；但最终运行时必须保留产品可观察的协议、重建规则和扩展行为。

## 提案

用一个 Rust 二进制替换 Node 宿主，同时保留浏览器客户端、Python 与 TypeScript SDK 客户端，以及现有持久化协议和网络协议。无法回放当前无密钥快照的替换是另一个 harness，不是这一个。

### 替换目标

完成意味着每条产品入口，包括 headless、ACP、SDK JSON-RPC，以及服务 `apps/web` 的 web 宿主，都从同一个 Rust 二进制运行，且用户运行时闭包中没有 Node。Vitest、doc-sync、文档网站、TypeScript SDK 构建和快照录制器等仓库开发工具可以继续使用 TypeScript。

迁移单元是能力闭包，不是 NPM 包。crate 可以独立实现，但只有在其 Service Definition、Service Provider、Consumer、持久化 effect、取消和 teardown 行为通过同一套一致性测试之后，profile 才能切换。`fs`、`subprocess` 和 `sandbox` 因而作为同一个执行世界迁移；`session`、`system-prompt`、`tools`、`agent` 和 `agent-loop` 作为模型可见主干迁移。

不在范围内：重写 React 客户端、复刻 Cordis HMR、在 Rust 组合器中求值任意 JavaScript，或热编译由模型写出的 Rust 插件。Typert 保留为 Host endpoint manifest（元数据清单）的构建期来源，不成为 Rust 运行时；`dsh-tool-cordis` 也只在 Node 根或临时 JS guest 阶段可以承载它时继续可用（[自指工具集](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)）。

### P0：协议与 schema 基础

P0 创建 `native/dsh/` Cargo workspace，但不改变任何产品 profile。在对应实现完成迁移前，现有 TypeScript 所有者继续作为真源；`scripts/` 下的生成器输出由 Rust 测试消费的已提交 fixture 和 manifest。一个协议同时只能有一个语义所有者：Rust 不手工维护 TypeScript union 或 endpoint 列表的第二份副本。

#### 兼容性分类

P0 为每个可观察接口记录兼容性类别，而不是要求所有 JSON 文档都逐字节相同。

| 接口 | P0 所有者 | 必须保持的兼容性 |
|---|---|---|
| 会话事件 envelope 和持久化 JSONL | [`dsh-session`](../../../../packages/core/session/README.md) 与持久化提供方 | 规范化后的持久化行保持逐字节相同；重建、未知事件拒绝和 `ignorable: true` 的语义保持一致 |
| SDK JSON-RPC | [`dsh-sdk-protocol`](../../../../packages/sdk/protocol/README.md) | 方法名、参数、结果、错误、通知顺序、取消和 NDJSON framing 与两个 SDK 客户端兼容 |
| ACP | [`dsh-acp`](../../../../packages/acp/acp/README.md) | 协议 frame 和自动化行为与 ACP 快照语料兼容 |
| Host API | [`dsh-host-apiproxy`](../../../../packages/host/apiproxy/README.md)、Typert Remote 定义与 GUI RPC 决策 | endpoint、具名参数、结果与错误 schema、权限、unary／stream 行为和顺序与现有客户端兼容 |
| 组合 | app-boot、bundle patch 与插件 Config schema | 有序 patch 替换、激活依赖、配置校验、`disabled`、`isolate` 和显式运行时值引用在 Rust 与 TypeScript 中得到确定性解释 |
| 迁移 bridge | `dsh-bridge-protocol` | 只保证相邻迁移阶段之间有版本的内部兼容；它不是公开 SDK 或第三方插件承诺 |

会话 schema 使用开放 envelope，而不是封闭 Rust enum。Rust 以通用形式表示 `{ type, seq, time, data, ignorable?, ...surfaceFields }`，通过注册式 codec 与 folder 分派已知 `type`，并可以为第一方事件暴露强类型视图。没有 `ignorable: true` 的未知事件会拒绝重建；可忽略的未知事件保留在原始日志中，只有不理解它的 projection 才跳过它。

Host manifest 从静态 `ApiProxy` 定义和 Typert Remote 元数据生成。它记录每个 endpoint 的 service、method、严格具名参数、结果 schema、错误标识、权限和 carrier 模式。Typert 留在构建平面；Rust 宿主加载生成的 manifest 与 dispatch 表。贡献 Host endpoint 的进程插件或 WASM 插件必须在自己的插件 manifest 中声明同样的元数据，不能依赖 TypeScript 运行时反射。

组合 v1 用带 tag 的数据节点替换任意 `!!js` 表达式，用于环境变量查找、平台选择、cwd 与 Harness home 等运行时路径、由已注入服务通过 schema 声明并暴露的 JSON 启动值，以及 CLI 提供的 overlay。每种节点都定义自己的求值阶段、缺失值失败和结果类型，且不能检查任意 service 对象。现有 `id`、`name`、`config`、`disabled` 与 `isolate` 行字段保留，但 Rust 不执行 JavaScript。P0 清点所有出厂 `!!js` 表达式，并在任何 profile 切换 composer 之前证明组合 v1 可以表示它们。

#### 生成产物与一致性验证

`native/dsh/contracts/` 存放生成的 JSON schema、endpoint 与事件 manifest、正向 fixture 和反例 fixture。每项产物都携带格式版本和来源摘要。新鲜度检查从 TypeScript 所有者重新生成这些产物，并在出现 diff 时失败；Rust 测试解码正向集合，以指定错误类别拒绝反例集合，并编码由 TypeScript verifier 再次读取的值。

一致性 runner 区分规范字节与语义。会话存储和明确规定为规范文本的协议比较规范化后的字节。SDK、ACP、Host、取消和生命周期用例比较解码后的 frame、顺序、错误标识和终态。时间戳、不透明 id、临时路径和传输分片边界，只有在现有快照策略已将其视为易变值时才进行规范化。

P0 把已经实现的 TypeScript 回合切换行为固化为 P5 的 oracle：持久化的 `turn/pending` 行、不会为该回合合成 `interrupted` closer 的 repair，以及 teardown 前确保该标记持久化的 shutdown flush 栅栏。P0 还会记录 P5 阶段才生效的自动续跑、持久续写游标和重复 `assistant/chunk` 抑制场景。这些未来场景在 P0 受新鲜度检查约束，但只有 P5 接管时才成为必须执行的一致性用例；它们不会假装 TypeScript 已实现[事件溯源式回合切换](2026-08-14-event-sourced-turn-switching.md)的第三步。

P0 还输出错误目录，记录 code、消息稳定性、可重试性、取消标识，以及错误是否跨越公开协议。TypeScript stack trace 和 Node 特有的 syscall 文案不属于兼容承诺，除非已有用户可见快照将其钉住。

只有在 Cargo workspace 可以构建、所有生成产物受新鲜度检查约束、两种语言通过同一套正向与反向 fixture、每个出厂 `!!js` 用法都有组合 v1 表达方式，且 `web`、`headless`、ACP 与 SDK profile 均未改变行为时，P0 才算完成。

### P1：双向迁移 bridge

P1 引入 `dsh-bridge-protocol`、Rust bridge 运行时和 TypeScript Cordis 门面。bridge 是对称的：Node 作为进程根时，门面调用 Rust sidecar；进程根倒置后，Rust 运行时可以用同一协议承载有截止日期的 JS guest。公开 SDK、ACP 与 Host 协议不会穿过或暴露 bridge frame。

#### 传输与握手

初始 carrier 使用子进程 stdin 与 stdout 上的 `Content-Length` framed JSON，与仓库已经验证的 LSP framing 模型一致。stderr 只用于诊断，绝不承载协议 frame。P1 的字节分片使用 base64，因为 bridge 是临时机制且正确性是首要约束；只有测得吞吐量或内存分配不达标时，才可以增加二进制 payload 扩展，而不改变逻辑消息。

双方都以 `hello { bridgeVersion, role, build, schemaDigest, capabilities }` 开始；版本、role 或 schema digest 不受支持时，在注册服务前拒绝连接。每个 frame 都携带连接 generation 和 request、resource、stream 或 continuation id。重连不会复用已失效 generation 的 id，因此迟到 frame 不能完成新的工作。

#### 逻辑消息

| 操作 | 必须保持的行为 |
|---|---|
| `call` / `reply` | 全双工、可重入的请求／响应，携带精确 service、method、参数、结果和类型化错误 |
| `cancel` | 幂等中止所拥有的 request 与全部子 resource；只有先发出终止 frame 的已完成 request 才获胜 |
| `resource/open` / `resource/release` | 传递不透明句柄，但所有权留在创建进程；断开连接释放所有 live handle |
| `stream/open` / `stream/chunk` / `stream/end` | 保留每条 stream 的顺序、终止错误或成功、有界缓冲、receiver credit 与取消 |
| `contribution/register` / `contribution/remove` | 在同一 plugin generation 下注册 service 与事件 listener，并作为一个可逆 effect 移除 |
| `event/invoke` | 携带 serial、parallel、emit 或 waterfall 分派，以及原始事件 payload 与 scoped registration identity |
| `continuation/call` / `continuation/reply` | 实现一次性的 waterfall `next()`，使 guest middleware 可以在下游 listener 前后都执行代码 |
| `dispose` / `quiescent` | 停止新工作，按 service 约定取消或 drain 已拥有工作，释放 resource，并且只在完全停稳后确认 |

当 callback 或 waterfall continuation 尚未完成时，连接必须继续读取 frame；一次只处理一个 request 的 reader 会在嵌套 `next()` 或 service callback 上死锁。continuation 是一次性、受 generation 约束的 resource。不调用 continuation 而直接返回，会像 Cordis 一样短路 waterfall。

每个经过 bridge 的字段都归类为 JSON 值、受所有者约束的 resource handle、取消信号或 continuation。可变 waterfall request 以值的形式穿过 `continuation/call`，再随下游结果返回，从而保留 middleware 的前置／后置行为，而不假装两个进程共享同一个对象引用。live `Agent`、process、terminal、iterator 与 callback 对象只能作为 handle 跨进程。依赖共享可变对象 identity 的 parallel event 不可通过 bridge，除非它获得显式 reducer，或其 listener 迁入同一进程。

类型化错误包含稳定 code、存在时的公开消息、可重试性、取消标记和结构化数据。远端 stack 只是诊断元数据，绝不替换本地错误标识。EOF、错误 framing、协议不匹配或子进程死亡会拒绝全部 pending operation、终止所拥有的 descendant，并使提供服务变为不可用；门面绝不在调用中途静默回退到另一实现。

流量控制必须显式实现。stream sender 不能超过 receiver credit，frame queue 有固定安全上限，取消 frame 不受普通数据 credit 限制。bridge 一致性测试包含 reader 停滞、backpressure 期间取消、嵌套 callback、重复终止 frame、旧 generation 迟到 frame、错误 frame，以及带 live PTY 时的进程死亡。

#### Cordis 与 Rust 所有权

在 Node 根下，每个 TypeScript 门面都是普通 Cordis 插件：它声明 injection，在 `ctx.effect()` 中 spawn 或取得 Rust sidecar，注册现有 `ctx` key，把 `AbortSignal` 转成 bridge 取消，并在 dispose 期间等待 bridge 完全停稳。Consumer 继续导入 Service Definition 包，无法从接口判断提供方由哪种语言实现。

在后续 Rust 根下，composer 直接挂载第一方 crate。JS guest 只能通过已声明的 bridge service 与事件注册贡献功能，不能通过隐藏 Node API 修改 Rust registry。plugin generation 拥有每项 registration、resource、callback、subprocess 和 stream，因此卸载一个 guest generation 时，必须先移除全部这些对象，下一个 generation 才能 ready。

迁移 bridge 不是最终第三方 ABI。在倒置进程根之前，另一项决策必须在两种方向中选定其一：封闭的第一方产品；或者稳定的进程／WASM 插件格式，并为 service、event、Host endpoint、权限和版本提供显式 manifest。Rust `dylib` 不是稳定的公开 ABI。

完整 bridge 默认也不是永久 worker 协议。P3 可以复用其 framing 以及 `call`、`cancel`、`stream`、`resource` 和 `dispose` 语义来验证执行 worker，但 P7 前必须由单独的版本化 manifest 冻结 resident worker 与 task worker 实际需要的最小内部 IPC 子集。guest contribution 与分布式 waterfall 消息保持迁移期专用，除非测量后的 worker 用例确实需要它们。

#### P1 实现顺序

1. 在 Rust 与 TypeScript 中实现 framing、握手、对称调用、类型化错误、取消、resource 所有权、流量控制和故障注入 fixture。
2. 通过 bridge 验证 `fs.resolve` 与文本读取，包括 alias identity、目标不存在、取消，以及隔离目录中的原子 mutation。
3. 验证 collect 模式与 piped subprocess 输出、取消、进程树终止、spill 报告和进程死亡。
4. 验证 PTY 分配、输入与输出顺序、resize、signal、foreground process 处理、取消和完整 session 完全停稳。
5. 验证一个合成 Cordis service callback，以及一个会调用 `next()`、包装其结果、执行短路、卸载并拒绝迟到 continuation 的 waterfall listener。
6. 让 Node 与 Rust 交换 root 和 guest role，运行同一批 fixture；此时任何出厂 profile 都不默认使用 bridge。

只有在全部六步均通过受支持的 macOS、Linux 与 Windows 进程语义、dispose 后不留下子进程或 open handle、协议故障快速失败，且交换 root role 不改变 fixture 时，P1 才算完成。执行世界提供方在 P3 切换，不在构建 bridge 期间切换。

### 原生运行模型

TypeScript 树已经实现事件溯源切换提案的第一步和第二步：阶段感知 drain 写入 `turn/pending`，pending tail repair 不合成 `interrupted`，shutdown 路径在 teardown 前 flush 所有 live session。第三步的自动续跑与 chunk 去重尚未实现。vendored Include guard 也会拒绝热应用改变核心 seam 的配置，并写入 `$DSH_HOME/restart-request`；仓库内存在请求生产方与测试，但没有组装后的 supervisor 消费方，因此登记式重启目前只是一条经过验证的过渡信号。

| 现有或拟议机制 | Rust 阶段 | 原生形态与所需证据 |
|---|---|---|
| TypeScript 切换第一步与第二步 | P0 fixture，P5 强制执行 | 以行为 oracle fixture 保留 `turn/pending`、pending repair、`TOOL_OUTCOME_UNKNOWN` 和 shutdown flush 栅栏；Rust 必须重放相同持久化行与终态 |
| 第三步自动续跑与 chunk 去重 | P5 | 作为第一版 Rust 主干的一部分：在持久续写游标下 append，幂等拒绝或合并重复 chunk，重建模型可见历史并唤醒 pending turn，不重放已完成工具的副作用 |
| 执行面 worker | P3、P5，然后 P7 | resident execution-world worker 拥有受约束的文件系统、subprocess、sandbox、PTY resource 与进程树；廉价隔离任务可用 task worker；placement 不改变 service API |
| 单写者与会话所有权 | P2 与 P5 | 持久化使用独占 session lease；agent 迁移后，其 worker 拥有 append 顺序、flush、resume cursor 与 release。supervisor 与 web host 不得写入同一个 live session |
| 阶段感知 drain 与卡死工具 | P5 | 原生复现现有阶段表。模型等待立即转为 pending；工具获得可配置且有界的完成期限，随后记录 unknown outcome 并释放所有权。3–5 秒只能作为待测候选值，不能成为协议常量 |
| 登记式重启 | P7 与 P8 | supervisor 状态机接受 restart request、停止 admission、按阶段 drain 或 cancel、flush owner、等待 quiescence、启动下一 generation 并发布 readiness。这会替换核心 seam HMR，而不是复刻它 |
| 蓝绿或预热宿主替换 | 默认不进入任何阶段 | 只有在冷启动、配置加载、会话重建与 readiness 测量无法满足明确可用性目标时，才增加第二个 host generation。worker ownership 应先让 live turn 不受 web host 重启影响 |

TypeScript 第三步不是 Rust P5 的前置条件。如果 P5 能在用户需要当前宿主具备崩溃续跑之前到达，就不应把完整 resume 与去重路径实现两遍。如果 Rust 排期无法满足这一产品需求，受限的 TypeScript 过渡方案是补齐登记式重启消费方及其运行测试；之后任何 drain 或 repair 语义变化都必须在同一变更中更新 P0 oracle。

### P1 之后的替换阶段

各阶段的出口必须顺序通过。阶段内部可以并行工作，但只有整个阶段的出口为绿色时，产品 profile 才能切换。

| 阶段 | 拥有 | 出口 |
|---|---|---|
| P0 协议与 schema 基础 | Cargo workspace、生成的约定、组合 v1、兼容性分类 | 新鲜度和双向一致性检查通过；profile 不变 |
| P1 双向迁移 bridge | framed IPC、生命周期、stream、resource、callback、事件贡献与故障处理 | 文件系统、subprocess、PTY、waterfall 和 root role 反转 fixture 通过；profile 不变 |
| P2 叶子与持久化 primitive | branded value、settings、credentials、attachment、spill、JSONL 与 SQLite primitive、session lease | TypeScript coordinator 通过门面使用 Rust 实现且行为一致；第二个 writer 无法获得同一个 live session |
| P3 执行世界 | `fs`、`subprocess` 与 `sandbox` 提供方、resident execution worker | 出厂 `web` 与 `headless` profile 使用一个受约束的 Rust 执行世界，并证明自有进程树完整 teardown；bash、PTY 与 LSP Consumer 不变 |
| P4 外部流式提供方 | DeepSeek 与后续 LLM 适配器、web fetch/search、MCP | 分片顺序、retry、取消、错误映射与 teardown 符合提供方 fixture |
| P5 模型可见主干 | 会话运行时与 projection、scope、system-prompt、tools、agent registry、agent-loop、agent-worker ownership | 具名 headless 与工具快照一致；pending turn 自动续跑、chunk 幂等、单写者 ownership、cancel、阶段感知 drain、failure、unload 与 empty-turn 行为通过 |
| P6 产品插件 | approval、commands、user questions、compaction、jobs、skill、workflow、goal、plan、todo、subagent | base 与 headless 运行时闭包不再需要其配置行的 Node 实现 |
| P7 进程根倒置 | Rust headless、SDK JSON-RPC、ACP 入口、supervisor、最小内部 worker IPC；可选的有截止日期 JS guest | 三条入口从 `dsh-runtime` 运行；SDK 与 ACP 组装测试通过；重启不会产生两个 session writer |
| P8 web 宿主 | 生成的 Host dispatch、HTTP uplink、WebSocket downlink、静态前端、登记式重启 readiness | 现有 React 客户端与浏览器 e2e 对 Rust 宿主运行；请求重启会 drain owner 并恢复 ready，且不改变 session 语义 |
| P9 从产品中移除 Node | 移除 JS guest 与 Node 发布闭包；保留 TypeScript 开发工具 | 发布物与组装产品测试只调用 Rust 宿主 |

### 插件与模块模型

第一方插件变成编入二进制的 Rust crate，并继续作为声明式组合中的配置行。Rust 运行时以显式 trait 实现服务注册、injection ready、可逆 effect，以及 emit、serial、parallel 与 waterfall 分派；它不复刻 TypeScript declaration merging 或 HMR。

树外扩展方式是必须在 P7 之前完成的产品决策。稳定的进程或 WASM 格式可以保留可替换配置行，而不随产品发布 Node；封闭产品则必须明确撤回这一承诺。P9 的唯一扩展机制不能是临时 JS guest。

这次替换也应从架构中移除 TypeScript 宿主机制，而不只是翻译它们。以下机制与 Rust 语法无关，它们定义模块如何保持可替换。

| 机制 | 所需设计 | 落点 |
|---|---|---|
| Capability manifest | 每个模块声明提供与需要的 service、event codec 与 listener、Host endpoint、permission、resource、placement option、版本范围和 shutdown policy | P0/P1 必需基础；第一方 crate 使用生成产物，进程／WASM 插件显式提供 |
| 生命周期所有权图 | 一个 plugin generation 拥有全部 registration、stream、continuation、process、timer 与 resource handle；unload 关闭 admission，并按确定顺序释放自有图 | P1 与 Rust runtime kernel 必需 |
| Worker placement policy | 模块可以是 `in_process`、`resident_worker` 或 `task_worker`；composer 验证其 service value 能否序列化，以及所有权要求是否允许该 placement | P3 设计并在 P7 前强制；不得产生按 profile 分叉的 API |
| 声明式组合 | bundle 与 profile 配置行继续作为有序数据，并使用受 schema 检查的 tagged runtime value；加载配置时不执行任意代码 | P0 必需，并供所有阶段使用 |
| 生成式 dispatch | Typert 与 TypeScript 声明生成 endpoint、event 与 schema manifest；Rust 编译静态 dispatch table，不做运行时反射 | P0 与 P8 必需 |
| 开放事件插件 | durable event type 注册 codec、兼容性类别、projection folder 与模型可见性元数据。需要共享可变 identity 的 parallel listener 改为显式 reducer，或保持同进程放置 | P2/P5 的 session 工作必需 |
| Supervisor policy | 模块声明 admission close、drain、cancel、snapshot 或 flush、restart dependency 与 readiness。restart request 是状态转换，不是 HMR callback | P5 前完成设计，P7/P8 激活 |
| 运行时 invariant | 登记式诊断检查单写者 ownership、resource 泄漏、陈旧 generation 与 quiescence，不向 `agent-loop` 增加条件分支 | 随所属阶段增加，并通过现有 diagnostics capability 公开 |
| 外部插件 ABI | 优先选择版本化进程或 WASM manifest，不选择 Rust `dylib`；注册前协商 capability 与 permission | 只有树外插件仍是产品要求时，才在 P7 前决定 |

Capability manifest、生命周期所有权、声明式组合、生成式 dispatch 和下述迁移 ledger 属于必需基础。Worker placement 与 supervisor policy 必须先有独立阶段决策和失败 fixture，才能启用。公开的进程／WASM 生态延后到产品确认外部扩展需求之后；现在设计 marketplace 或宽泛的稳定 ABI，会增加宿主替换本身不需要的承诺。

### Rust crate 拓扑与迁移 ledger

目标是小型 runtime kernel 加 capability family，而不是把 219 个包逐个翻译为 219 个 crate。`dsh-runtime` 拥有组合、registry、事件分派、lifecycle generation 与入口；`dsh-contracts` 拥有生成的协议视图；`dsh-session` 拥有开放事件 envelope、codec、projection、lease 与 resume cursor；`dsh-execution` 拥有文件系统、subprocess、sandbox、terminal resource 与 worker placement；`dsh-agent` 拥有 scope、prompt、tools、registry 与 loop；`dsh-providers` 归集外部 LLM、web 与 MCP adapter，但不合并其独立配置；`dsh-host` 拥有 SDK、ACP、Host dispatch、HTTP、WebSocket 与静态资源服务；`dsh-supervisor` 拥有进程 generation 与登记式重启。产品插件在独立演进时仍保持独立 crate，而 `dsh-bridge-protocol` 始终是可移除的迁移依赖。

`native/dsh/migration/package-map.json` 作为机器可读迁移 ledger，`docs/rust-migration-matrix.md` 作为其生成的人类视图。生成器盘点所有 DSH `package.json`、内部 peer dependency 边、capability role、出厂 composition row 与 bundle patch；维护者补充 target crate 或保留 TypeScript 的处置、phase、status、conformance fixture、runtime placement 与 `removeAfter` gate。CI 拒绝未知 package，也拒绝依赖闭包仍选择未记录 Node 实现的已迁移配置行。这样可以提供所需的包与引用关系清单，同时避免让人工维护文档成为真相源。

### 清单

替换实现并保留 Service Definition：`fs` / `fs-local` / `fs-sandbox`、`subprocess` / `subprocess-local`、`sandbox` / `sandbox-local` / `sandbox-windows-acl`、会话持久化 JSONL 与 SQLite、`session-query-sqlite`、`llm-deepseek` 及后续适配器、web fetch/search、`attachment-local`、`spill-local`、`settings-file` 和 `credentials-local`。

按相同语义重实现：`session`、`system-prompt`、`tools`、`agent`、`agent-loop`、`scope`、`approval`、`commands`、`user-questions`、`subagent` 及进程内提供方、`compaction`、`jobs`、`skill`、`host-apiproxy`、`webserver` 和 `frontend-static`。

不迁：HMR、Typert 运行时反射、任意 `!!js`、`tsx` 源码启动和 Node `workflow-worker-thread` 引擎。在该配置行迁移时，用原生或独立进程实现替换 workflow 引擎。

留在 TypeScript 一侧：`apps/web` 与 `packages/client`、Python 与 TypeScript SDK 客户端、文档网站，以及使用公开协议的快照录制器。

## 考虑过的替代方案

**一次重写 Cordis、循环和 web 客户端。** 否决：插件树、会话重建和快照语料定义了产品行为。从零开始的 Rust harness 会在能够测量兼容性之前就形成另一个产品。

**按目录顺序把 NPM 包翻译成 crate。** 否决：包边界不能包住生命周期行为。缺少 `subprocess` 的 `fs` 会破坏执行世界 identity，缺少会话 projection 与事件 middleware 的 `agent-loop` 会破坏模型可见重建。

**为每个提供方建立独立 CLI 协议。** 否决：每个临时进程包装层都需要自己的取消、stream、错误、所有权与 teardown 规则，进程根倒置后又无法复用。一条对称 bridge 让这些规则只有一套实现和一套故障测试。

**只使用 unary JSON-RPC，推迟事件语义。** 否决：subprocess 与 PTY 会暴露 live resource，产品插件也会贡献 callback 与 waterfall listener。unary bridge 可以迁移叶子方法，却不能承载进程根倒置所需的临时 guest。

**等全部插件都变成 Rust 后再倒置进程根。** 这条路线可行，但不作为主方案：它会把 Rust 入口与 SDK 的证据推迟到最后，并使最终切换范围过大。如果 P6 先完成所有配置行，P7 仍可以不启用 JS guest。

**永久嵌入 JavaScript 引擎，让 TypeScript 插件继续加载。** 作为完成条件被否决：永久 guest 是双运行时。有截止日期的 guest 只允许用到 P8。

**在 Rust 中复刻 Cordis declaration merging、HMR 与 Typert reflection。** 否决：它们是 TypeScript 宿主机制。Rust 通过显式 trait 与生成 manifest 保留可观察的服务、生命周期、事件和 Host endpoint 语义。

**在开始 Rust 主干前先完成 TypeScript 第三步。** 不作为默认顺序：第一步和第二步已经提供持久行为 oracle，而在两个宿主中分别实现 continuation cursor 与 chunk 幂等，会把风险最高的工作做两遍。只有在 P5 之前出现有证据的当前宿主需求时才重新考虑。

**把蓝绿重启作为 Rust 初始架构的一部分。** 在没有测量前否决：应先用 worker ownership 与原生 supervisor 隔离 turn 和 host replacement。只有可用性目标与冷启动 benchmark 证明仍有必要时，才增加重叠的 host generation。

**让每个插件都运行在独立进程。** 否决：不同 capability 的隔离、序列化、调度与 teardown 成本不同。placement 按模块声明；纯逻辑或延迟敏感的第一方 crate 默认仍在进程内。

**把容器或 microVM 当作 `ctx.sandbox` 提供方。** 被现有沙箱决策否决：它们替换的是 `fs` 与 `subprocess` 执行世界，不是与宿主共享文件系统和内核的约束运行器。

**用 Rust 重写 React 客户端。** 否决：浏览器已经是 Host RPC 后面的独立进程。替换它与从产品运行时移除 Node 无关。

## 验收标准

- P0：生成的 schema、manifest、正向与反例 fixture、错误目录、组合 v1 清单、TypeScript 第一步／第二步回合切换 oracle 与 P5 阶段才生效的续跑场景都受新鲜度检查约束；当前已有所有者的用例通过双向一致性验证；profile 不变。
- P1：对称 bridge 调用、stream、resource、取消、callback、waterfall continuation、dispose、backpressure、故障注入和 root role 反转通过；文件系统、subprocess 与 PTY 原型不留下进程或 handle；profile 不变。
- P2-P4：叶子、持久化、执行世界和外部提供方门面，只有在聚焦一致性测试与组装快照通过后才默认使用 Rust；session lease 拒绝第二个 writer；受约束 worker 证明进程树完整 teardown；shadow 对比绝不双写生产状态。
- P5-P6：模型可见主干与产品插件生成兼容的会话日志和组装输出；pending turn 在持久游标下自动续跑，重复 chunk 不改变重建输出，已完成工具不重放，卡死工具处理有界，且 cancel、drain、failure 与 unload 语义一致。
- P7-P8：headless、ACP、SDK 与 web 入口作为 `dsh-runtime` 运行；最小 worker IPC 与 supervisor 阻止 session owner 重叠；登记式重启到达 quiescence 并恢复 ready；现有 SDK、ACP、Host 与浏览器套件通过，且不重写客户端。
- P9：产品文档与发布物没有 Node 运行时依赖；JS guest 不存在；快照与组装 e2e 作业只调用 Rust 宿主；明确写出受支持的树外插件立场。
- 迁移盘点：生成的 package matrix 覆盖每个 DSH package 与内部依赖边；每个已迁移 composition row 都声明 target、fixture、placement、phase 与 Node removal gate。

## 风险

- **两个语义所有者。** 手工维护的 Rust 与 TypeScript schema 会发生漂移。P0 只允许一个所有者和生成产物；新鲜度检查失败会阻止迁移。
- **分布式 waterfall 死锁。** 嵌套 callback 与 `next()` 要求可重入 frame 处理和一次性 continuation 所有权。P1 故障测试钉住行为与失败。
- **bridge 内存无界增长。** 快速 producer 可能超过 guest 或门面的消费速度。receiver credit、有界 queue、取消优先级和进程死亡清理是协议要求，不是提供方约定。
- **shadow 副作用。** 对比两个实现可能重复写入或启动 subprocess。有状态对比使用隔离目录、一次性数据库或录制输入；生产状态绝不双写。
- **快照锁死 TypeScript 意外行为。** fixture 可能编码 Node 特有的时序或文案。只有公开文本和明确顺序保持兼容；易变字段沿用现有规范化策略。
- **回合切换语义漂移。** TypeScript 已经拥有 `turn/pending`、pending repair 与 shutdown flush 栅栏。之后任何 drain 或 repair 变化都必须在同一变更中更新 P0 fixture 与 P5 阶段用例；prose 不是第二个语义所有者。
- **会话 split brain。** supervisor 或第二个 worker 可能在 ownership 已转移后继续 append。session lease 按 generation 限定，append 校验当前 owner，takeover 必须等待前一 owner 死亡或完成 release 后才能 resume。
- **Bridge 固化。** 把完整迁移 bridge 用作内部 worker 协议，会保留 guest 专用的 contribution 与 waterfall 复杂度。P7 冻结更小的 worker 协议，并保持 bridge 可移除。
- **未验证的重启假设。** 仓库还没有 Rust 启动与重启窗口收益的 benchmark，TypeScript 树也只有 restart-request 生产方，没有组装后的消费方。移除 fallback 或增加蓝绿复杂度之前，必须测量冷启动、配置加载、会话重建、drain 与 readiness。
- **开放 session event 覆盖不足。** 注册式 codec 与 folder 模型必须包含现有 `turn/pending` 行并保持其 canonical byte。把该事件当作 unknown 或 ignorable，会把可续跑回合静默变成不兼容状态。
- **JS guest 变成永久组件。** P9 禁止随产品发布它。在扩展决策与 guest 移除条件明确前，P7 不得开始。
- **插件作者失去 TypeScript `apply(ctx)`。** 完成替换就无法在没有 Node 的情况下保留这个 API。进程／WASM 格式可以保留可替换组合行，但明确不承诺 TypeScript 插件源码兼容。
- **原生启动器范围仍不明确。** 从产品运行时移除 Node，并不会自动重写现有 C11 Landlock 可执行文件。若目标是所有原生代码都使用 Rust，就必须迁移它，或把它记录为经过审计的例外。
