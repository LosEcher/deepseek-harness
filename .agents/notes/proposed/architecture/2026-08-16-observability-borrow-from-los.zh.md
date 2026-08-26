# Agent Note: 从 los 借鉴的可观测性清单（对比评审）

Status: implemented (items 1, 3); open (items 2, 4, 5)

> Update 2026-08-16：item 1（P1 `/metrics`）已实现为 `@deepseek-ai/dsh-observability` bundle（见
> `.agents/notes/implemented/feature/2026-08-16-observability-metrics-endpoint.md`），含 `turn/pending` 指标面。
> Update 2026-08-23：item 3（usage/cost 立方）也已在同一 bundle 实现——`/observability/summary`
> 按 provider/model 路由折叠 token/cost（DeepSeek 峰谷 CNY 计价）。items 2、4、5 仍开放。

[English](2026-08-16-observability-borrow-from-los.md) | 中文

Date: 2026-08-16

## Problem

DSH 与 los 的可观测性系统对比（报告：los 仓库 `docs/research/2026-08-16-observability-comparison-dsh.md`）确认：DSH 的事件溯源会话日志是强基座——回放、审计、统计结构性免费（追加日志 + 派生投影），遥测接缝（脱敏瀑布、移交游标、FULL/FEEDBACK_ONLY/DISABLED 三模式、共享披露）领先于 los。但对比也暴露了 los 有而 DSH 缺的五项能力。本 note 记录借鉴清单，使缺口显式化，待有部署提出需求时按优先级拾起。

## Gaps（los 有而 DSH 缺的能力）

1. **Prometheus 指标端点**。los 暴露 `GET /metrics`（Prometheus 文本格式），全部样本从 PostgreSQL 证据聚合（重启不丢）。DSH 无 `/metrics` 端点、无进程级 gauge。对 DSH 而言天然数据源就是会话账本：活跃会话数、事件吞吐、`turn/pending` 计数（当前既无 UI 也无指标面）、压缩计数。
2. **质量评估框架**。los 持久化 `run_evals`（success/latency/tool errors/verification status/model cost/failure class，pairwise A/B 带 baseline/candidate run spec id、rubric 版本）与 `daily_agent_quality_snapshots`（按 tenant/project/date 幂等快照：inbox/schedule/recovery/verification/provider quality）。DSH 有 eval 测试基建但无持久化质量证据表。
3. **用量/成本立方**。los `GET /usage/summary` 按 provider/model/day 聚合 token/cost/缓存命中证据，带证据分类契约（L1 los_runtime 权威、L2 wire_inspect 预留、L3 外部 CLI 舰队仅总览）。DSH 有 token 投影但无成本立方。
4. **外部 agent 遥测摄入**。los 运行本地 OTLP/HTTP bridge（4318）把外部 agent CLI（Claude Code / Codex）span 映射进会话事件账本。DSH 的 hooks-claude-code / hooks-codex 是行为钩子，不是遥测摄入。
5. **每日趋势读模型**。los `daily_agent_quality_snapshots` 是点时刻读模型，带 `collecting`/`complete` 证据窗口（28 天）。DSH 有投影机制（`session-projection`）但无按日期幂等的快照语义。

## Suggested priorities（拾起时）

- P1：基于会话账本聚合的 `/metrics` 端点（顺带补上 `turn/pending` 可见性——已知 GUI 缺口）。
- P2：持久化质量证据表（与 eval 包对齐，待有部署提出纵向质量需求时）。
- P2：用量/成本立方（需要事件流带成本元数据或 provider usage 归一化）。
- P3：外部 agent OTel 摄入（仅当 harness 把外部 CLI 包装为一等运行时）。
- P3：按日期幂等快照（投影机制已有，新的是快照语义）。

## Alternatives considered

**五项并入单一「可观测性包」**。被拒：metrics、质量证据、成本、摄入、快照的消费者与成熟度各不相同；借鉴清单保持清单形态，直到有部署提出需求——与本仓库「默认关闭、按需开启」的遥测策略一致。

**用 los 的 PostgreSQL 账本替代 JSONL 事件日志**。被拒：DSH 事件溯源日志已结构性提供回放/审计，文件式追加格式是既有决策（见 session-persistence 系列 notes）；借鉴是增量，不是基座替换。

## Consequences

五项缺口保持文档化、按优先级排序、与任何单一功能解耦。实现第 1 项（metrics 端点）将顺带关闭 `turn/pending` 可见性缺口。本 note 不改变任何当前运行时行为。
