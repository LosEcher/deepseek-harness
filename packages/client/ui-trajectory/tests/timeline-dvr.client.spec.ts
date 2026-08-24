/**
 * timeline-dvr.client.spec.ts — 锁定 trajectory timeline 的 DVR 语义（zoetrope Z-3）
 *
 * zoetrope 借鉴点验证（dsfolder/ZOETROPE-HARNESS-BORROW-2026-08-24.md §6 Z-2/Z-3）：
 *   1. 右边缘 = 最后事件（非 wall-clock now）——时间域 end 完全由 spans 决定，
 *      纯函数无 now 参数，重启/恢复后不会向"现在"长空尾巴。
 *   2. 空闲压缩（duration 模式）——压缩 span 之间死区，忠实模式（actual）保留。
 *   3. 事件索引（sequence 模式）——操作序列位置投影，与时间无关。
 */
import { describe, expect, it } from 'vitest'
import type { TrajectoryCellKind, TrajectoryCellProps } from '../src/client/trajectory-record.ts'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'
import { deriveTrajectoryTimeline } from '../src/client/timeline.ts'

function cell(
  index: number,
  startedAt: number,
  timeSeconds: number | null,
  kind: TrajectoryCellKind = 'tool',
  isError = false,
): TrajectoryCellProps {
  return { index, kind, text: `cell-${index}`, startedAt, timeSeconds, isError } as TrajectoryCellProps
}

function turn(n: number, cells: TrajectoryCellProps[]): TrajectoryTurnModel {
  return { turn: n, groups: [{ title: `turn-${n}`, cells }] }
}

/** turn1 事件在 t=1000..1005，turn2 事件在 t=5000..5005（4 秒空闲） */
function twoTurnsWithIdleGap(): TrajectoryTurnModel[] {
  return [
    turn(1, [
      cell(1, 1000, 1),   // 1000..1000+1000ms → end 2000
      cell(2, 2000, 2),   // 2000..4000
    ]),
    turn(2, [
      cell(3, 5000, 1),   // 5000..6000
      cell(4, 6000, 0.5), // 6000..6500
    ]),
  ]
}

describe('Z-3 DVR: 右边缘 = 最后事件（非 wall-clock）', () => {
  it('actual 模式时间域 end == 最后 span 的 end（=最后事件时间）', () => {
    const model = deriveTrajectoryTimeline(twoTurnsWithIdleGap(), 'actual')
    expect(model).not.toBeNull()
    // 最后事件 cell4: start 6000, duration 0.5s → end 6500
    expect(model!.end).toBe(6500)
    expect(model!.start).toBe(1000)
  })

  it('时间域是纯函数：无 wall-clock 输入（签名无 now/Date.now），同输入重算一致', () => {
    const turns = twoTurnsWithIdleGap()
    const first = deriveTrajectoryTimeline(turns, 'actual')
    const second = deriveTrajectoryTimeline(turns, 'actual')
    expect(second!.start).toBe(first!.start)
    expect(second!.end).toBe(first!.end)
    // 右边缘不随真实时间漂移：即使延迟重算，end 仍是最后事件时间
    expect(second!.end).toBe(6500)
  })
})

describe('Z-3 DVR: 空闲压缩（duration 模式）', () => {
  it('duration 模式压缩 span 间死区：总长 = 事件耗时之和，短于 actual', () => {
    const duration = deriveTrajectoryTimeline(twoTurnsWithIdleGap(), 'duration')!
    const actual = deriveTrajectoryTimeline(twoTurnsWithIdleGap(), 'actual')!
    // 事件耗时：1+2+1+0.5 = 4.5s = 4500
    expect(duration.end - duration.start).toBe(4500)
    // actual 含 4s 空闲：6500-1000 = 5500
    expect(actual.end - actual.start).toBe(5500)
    expect(duration.end - duration.start).toBeLessThan(actual.end - actual.start)
  })

  it('duration 模式 turn 边界被压缩后前移（空闲被移除）', () => {
    const model = deriveTrajectoryTimeline(twoTurnsWithIdleGap(), 'duration')!
    // turn2 第一事件原在 5000；空闲 1000(4000→5000 gap=1000ms) 被移除 → 序列位置 4000
    const turn2 = model.turnBoundaries.find(b => b.turn === 2)
    expect(turn2).toBeDefined()
    expect(turn2!.time).toBe(4000)
  })
})

describe('Z-3 DVR: 事件索引（sequence 模式）', () => {
  it('sequence 模式按操作序列位置索引，与时间无关', () => {
    const model = deriveTrajectoryTimeline(twoTurnsWithIdleGap(), 'sequence')!
    // 4 个非 requestOnly cell → 序列长度 4
    expect(model.start).toBe(0)
    expect(model.end).toBe(4)
    expect(model.spans).toHaveLength(4)
    // 时间顺序与索引顺序一致（spans 已按 turns/groups 顺序投影）
    expect(model.spans[0]!.start).toBe(0)
    expect(model.spans[3]!.start).toBe(3)
    // turn 边界在序列位置（turn2 边界在 index 2）
    const turn2 = model.turnBoundaries.find(b => b.turn === 2)
    expect(turn2!.time).toBe(2)
  })

  it('isError 标记保留在 span 上（失败 marker 数据基础）', () => {
    const turns = [turn(1, [cell(1, 1000, 1, 'tool', true), cell(2, 2000, 1)])]
    const model = deriveTrajectoryTimeline(turns, 'sequence')!
    expect(model.spans[0]!.isError).toBe(true)
    expect(model.spans[1]!.isError).toBe(false)
  })

  it('requestOnly 记录不占序列位置', () => {
    const turns = [turn(1, [cell(1, 1000, 1), { ...cell(2, 2000, 1), requestOnly: true }])]
    const model = deriveTrajectoryTimeline(turns, 'sequence')!
    expect(model.end).toBe(1) // 只有 cell1 可见
  })
})

describe('Z-3 DVR: 空输入与退化', () => {
  it('无可见记录返回 null', () => {
    expect(deriveTrajectoryTimeline([], 'sequence')).toBeNull()
    expect(deriveTrajectoryTimeline([], 'actual')).toBeNull()
  })

  it('无 startedAt 的 cell 在 timed 模式被跳过，sequence 模式保留', () => {
    const turns = [turn(1, [cell(1, 1000, 1), cell(2, null as unknown as number, null)])]
    const timed = deriveTrajectoryTimeline(turns, 'actual')
    expect(timed).not.toBeNull()
    // 只有一个有 startedAt 的 span
    expect(timed!.spans.length).toBe(1)
  })
})
