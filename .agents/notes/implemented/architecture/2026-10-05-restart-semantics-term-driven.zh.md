# Agent Note：重启是 TERM 驱动的；重启协调器不在本线

Status: implemented

[English](2026-10-05-restart-semantics-term-driven.md) | 中文

## 问题

某受监督部署通过写 `$DSH_HOME/restart-request` 来重启 `dsh web`，然后等待宿主自行退出。本线上从来没有消费者读这个文件，于是每次请求都落到监督者的 600 秒兜底、以 SIGTERM 杀掉宿主。生产日志把这段等待完整记录了三次（两天内），其中一次还落在会话进行中：

```
10-03 21:44:58 AUTO-RELOAD: restart-request; restart request published, awaiting host drain
10-03 21:54:58 coordinated exit timeout (600s); forcing TERM
10-05 09:29:52 AUTO-RELOAD: profile-plugin-manifest; ... awaiting host drain
10-05 09:39:52 coordinated exit timeout (600s); forcing TERM
10-05 11:11:46 AUTO-RELOAD: profile-plugin-manifest; ... awaiting host drain
10-05 11:21:48 coordinated exit timeout (600s); forcing TERM
10-05 22:42:20 AUTO-RELOAD: restart-request; (merged) ... awaiting host drain
10-05 22:52:25 child exited rc=143 reason=process-exit
```

根因是血统分叉，不是回归。协调式重启建立在 fork 的 rc.8 血统（`master` = `fork/master`）上：`apps/cli/src/restart-coordinator.ts`、agent-loop 的排空闸（`markDraining`、`hasBlockingActivity`、`abortBlockingActivity`、`clearDraining`）、阶段感知快退排空及其配套——提交 `c383e7f9`、`19d170f7`、`474fd247`、`60fae479`、`2dbd9562af`、`35c356e194`、`a3814690ac`、`86380cb016`、`3f6858658e`、`f9304445b4`、`97ff8c0500`。本线派生自 upstream `0.1.5-rc.2`，这些一个都没有：`restart-coordinator.ts` 不存在，没有任何源码文件读 `restart-request`，`turn/pending` 在这里也不是事件类型。只有被 gitignore 的陈旧构建产物还挂着协调器的名字，于是检索代码树的人会读到声明却找不到实现。

声明比机制活得更久的还有五处：监督者脚本的头注释及其 `COORDINATED_EXIT_TIMEOUT`；重启脚本的头注释与「host coordinator 也会消费本文件」那句；`dsplugins/dsh-restart-banner`（README、bundle patch，以及一个会写出无人消费信号的 host 半包）；遗留的 `$DSH_HOME/restart-exited` 痕迹；以及孤儿产物 `lib/types/restart-coordinator.*` 与 `lib/types/resume-context.*`。

## 决策

本线的重启就是 [Bounded, escalating signal shutdown for Web and headless](../bug-fix/2026-08-03-cli-signal-shutdown-escalation.zh.md) 已经拥有的信号语义：`apps/cli/src/profile-boot.ts` 的 `process.on('SIGTERM', () => { interrupt(0) })`，随后 `signalShutdown.abort()`、`createProcessShutdown` 拆除 Cordis 树、以退出码 0 退出，`PROCESS_SHUTDOWN_TIMEOUT_MS = 5000` 作为强制退出兜底；SIGINT 报 130。持久性来自持久化 provider 自己的 effect 收尾——关闭每个打开的写句柄并排空其缓冲（`packages/session/session-persistence-jsonl/src/storage.ts`），而不是来自什么协调器。

因此重启由监督者自己驱动：它消费 `restart-request`，对持有 `:3080` 的进程发 TERM，并把 wrapper 的 `143` 退出码当作「监督者驱动停止」的正常形态，而不是重启失败。有界宽限（此处 20s，对宿主的 5s 预算）到点后升级到 wrapper 并回收端口。`restart-request` 仍是脚本与 agent 的公开触发文件；它不再是对接握手，任何组件都不得再等待宿主自行退出。

在途模型输出与工具调用不被等待。未闭合回合不会被标 `turn/pending`——本线没有该事件——因此下次启动时由 crash-repair 合成 `interrupted`（`packages/core/session/src/repair.ts` 的 `interruptedTurnClosers`）。接受这份损失正是换取有界窗口的代价，而且它本来就已经是事实行为：上面那段兜底两天里产出的都是 `rc=143` 重启。

Rust 迁移继承的是机制而不是这份实现。排空、回合边界退出与 resume 归 **P5**（模型可见主干）；supervisor 及其重启协议归 **P8**（web 宿主原生 supervisor）。`master` 血统上的 TypeScript Step 1/2 保持为 P5 夹具与一致性测试的**行为 oracle**——这也正是 fork 的 P0–P9 计划（`.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md`，只存在于那条血统）给它的定位——本笔记记录的是：该 oracle 不是本线的生产代码。

## 考虑过的替代方案

**把协调器与排空重新移植到本线。** 否决，依据是相对既定替换路线的实测成本。那十一个提交合计约 1,765 行新增，横跨 `apps/cli`、agent loop、session、core tools、host apiproxy 与 client UI；而移植目标恰好是 upstream 重写过的文件——`packages/core/agent-loop/src/agent.ts` 与 `src/index.ts`、`packages/core/session/src/repair.ts` 与 `src/types.ts`、`packages/core/tools/src/index.ts`、`apps/cli/src/profile-boot.ts` 相对 `master` 相差 965 行新增 / 1,372 行删除——十一个 cherry-pick 全部冲突。P5 与 P8 会替换掉这套机制，所以移植就是此前把 TypeScript Step 3（resume 自动续跑与 chunk 去重）挡在本线之外的那种双倍投入。

**保留等待、只缩短兜底。** 否决：等待本身编码了一个没人实现的握手；缩短超时只是让错误的模型更快失败，而且宿主的退出仍由监督者的计时器决定，而不是由宿主自己那段有界收尾决定。

**删掉 `restart-request`，一律直接 TERM listener。** 否决：该文件是本部署的公开重启接口——重启脚本、agent、重启时间线工具都在写它；一旦监督者不再等它，这个文件每轮轮询只花一次 `ls`。

**把回合标成 `pending`，好让 resume 续跑。** 在此否决，理由同上：该事件类型及其消费者属于 P5。合成一个没有读者的标记，正是本笔记要消除的那类缺陷。

## 影响

一次重启的代价是：TERM、至多 5s 拆除、1–5s 重启延迟、健康窗口——生产上约 10–20s，而不是 600s。重启瞬间在途的工作会由 `interrupted` 修复丢失，直到 P5 落地 resume 为止。banner 插件处于休眠且 fail-closed：契约缺失时它报 `{supported: false}`，并拒绝立即重启动作，而不是写一个无人消费的信号。

## 验证

`dsfolder/scripts/check-restart-contract.sh` 断言声明与生效一致，并带 `--self-test`：把每条违规注入为负向控制——宿主声明 `SIGTERM → interrupt(0)` 且不含协调器消费者；监督者没有协调等待且对 `:3080` listener 发 TERM；没有任何 profile manifest 安装 `dsh-restart-banner`；代码树里（含孤儿构建产物）没有任何文件在提重启协调器。上面那段日志即该检查所防缺陷的复现。
