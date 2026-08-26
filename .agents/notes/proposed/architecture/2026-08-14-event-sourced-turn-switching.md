# 事件溯源式回合切换（Event-Sourced Turn Switching）— 方案 C 决策记录

- 状态：**已实施**（2026-08-16 核实：C1 阶段感知快退 86380cb016、C2 repair 保留未闭合 19d170f741、C3 resume 自动续跑 6f5dffdd5e 均已上 master；原"待分步实施"为过时状态）
- 归属：dsh web 无感切换 / 排空机制的架构性演进
- 分支：feat/tool-shutdown-drain（已删除，实现并入 master）
- 实施参考：`.agents/notes/implemented/architecture/2026-08-15-pending-turn-resume-and-drain-gate.md`、`packages/core/agent-loop/tests/{resume,drain,resume-context}.spec.ts`

## 背景：排空机制补丁演进史（为什么不继续打补丁）

| # | 提交 | 机制 | 局限 |
|---|---|---|---|
| 1 | 5998f6a3 | tools drain：SIGTERM 等顶层工具调用（10s） | 只覆盖工具窗口 |
| 2 | 16b906c4 | scheduler dispatch 门控；双 SIGTERM force-exit 修复 | 重启脚本不再 kill pnpm |
| 3 | e17695f1 | turn drain：回合排空到 turn/end completed（drainGraceMs 30s） | 固定宽限 |
| 4 | d195a994 | pre-teardown drain：fiber 拆树前显式 drain（session 仍可写） | 仍是"等回合完成"范式 |

**实测数据（2026-08-14，dsh-restart-timeline.py）**：

- 22:33 案例：SIGTERM 落在模型流**尾部** → turn `completed`（成功）
- 22:44 案例：SIGTERM 落在 **step 边界 + 模型流刚启动** → turn `interrupted`（repair 合成，turn/end 未落盘）
- 22:57 案例：长工具在途 → tools drain 10s 超时 + agent drain 30s 超时 → **重启窗口 47s**，两个其他会话回合 interrupted
- 全量：早期 interrupted 率 82.4%（旧代码时代）→ 近期 50%

**结论**：固定宽限范式（无论静态 30s 还是动态续期）本质是"等播放器播完"——要么窗口长、要么杀回合。继续调宽限/阈值就是打补丁，不会收敛。

## 决策：回合语义从进程内存迁移到事件流

DSH 是事件溯源架构（`session.jsonl` 全量事件，`turn/start → step/start → … → tool/result → step/end → turn/end`）。回合**不是**进程内存里"正在跑的东西"，而是事件流里的一个区间；进程只是**播放器**。因此：

> **切换 = 随时停播放器（快速退出，窗口 ~10s 恒定）**
> **续跑 = 重启后用事件流重建回合（resume + deriveMessages 已有）**
> **回合不依赖进程存活 → 崩溃（SIGKILL）同样可续跑**

三个组件（各自都是 DSH 既有机制的协同，非新造轮子）：

1. **阶段感知切换**（替代固定宽限）：shutdown 按回合当前执行阶段决策，不靠超时猜测
   - 模型请求在途（step 内 stream，无副作用）→ **不等，标记 pending 快退**
   - 工具调用在途（副作用）→ **等工具完成**（结果必须落盘）；卡死 → 标记 `TOOL_OUTCOME_UNKNOWN`（已有语义）
   - 回合间隙 → 立即退出
2. **未闭合回合 = 天然 pending**：正常关闭时 repair **不再合成 interrupted**——`turn/start` 无 `turn/end` 的区间在事件流里就是"待续跑"；崩溃同理（事件流完整）
3. **resume 自动续跑**：resume 检测最后未闭合回合 → `deriveMessages()` 重建（已含工具结果）→ 自动 wake → 重发模型请求。模型只读历史消息（工具调用是历史，不会重放），语义安全

## 方案对比

| 维度 | A 进展续期 | B 快退+标记 | **C 事件溯源（本决策）** |
|---|---|---|---|
| 重启窗口 | 最长=模型响应时间 | ~10s | **~10s 恒定** |
| 长模型回合 | 保住 | 续跑保住 | 续跑保住 |
| 卡死回合 | 15s 判定 | 3-5s 标记 | 阶段判定（工具在途才等） |
| 复杂度 | 低 | 中 | 中 |
| 回合永不丢 | 否 | 是（除崩溃） | **是（除事件流损坏）** |
| 与 DSH 契合度 | 补丁 | 过渡 | **原生**（复用 resume/deriveMessages/repair） |

## 技术难点与风险

1. **模型重发幂等**（最大风险点）：续跑重发模型请求 → 同 step 可能出现两批 `assistant/chunk`——需跳过已落盘内容（对比续写）或定义追加续写语义
2. **repair 行为变更影响面**：`interruptedTurnClosers` 被恢复路径 / web GUI / 测试契约依赖——"不关回合"需所有消费方适配 pending 状态显示
3. **工具在途窗口**：工具执行中退出（>快退窗口）→ 结果丢失 → 续跑走 `TOOL_OUTCOME_UNKNOWN`（只读可重试、有副作用需人工确认）——诚实边界
4. **阶段判定可靠性**：回合阶段从事件流推断（最近事件类型/时间）→ 需与 agent-loop phase 状态一致性验证

## 实施路线（三步，每步独立可验证）

1. **阶段感知快退**（改动最小）：drain 按阶段决策 + 工具在途才等待 + pending 标记；重启窗口 47s → ~10s
2. **repair 保留未闭合**：正常关闭不合成 interrupted；GUI/恢复路径适配 pending 显示
3. **resume 自动续跑**：事件重建 + 重发 + chunk 去重；崩溃续跑（最后一块拼图）

## 迭代原则（本决策附带的工作约定）

- 后续统一按**更优架构设计**（合理、可扩展、可维护）方案推进，**不持续打补丁**
- 如有更优方案：基于**数据评估**（时间线工具、interrupted 率、重启窗口分布）后分析设计，再迭代升级
- 每次迭代在本文件记录数据依据与决策变更
