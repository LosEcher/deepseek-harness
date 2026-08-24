import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { buildResumeInterruptionContext, collectTurnStreamText, RESUME_INTERRUPTED_LEAD } from '../src/resume-context.ts'

function chunkEvent(turn: number, step: number, text: string, seq: number): SessionEvent {
  return { type: 'assistant/chunk', seq, time: seq, data: { turn, step, chunk: { type: 'text-delta', index: 0, text } } }
}

describe('buildResumeInterruptionContext (A2/A3)', () => {
  it('no already-produced text: interruption notice only', () => {
    const ctx = buildResumeInterruptionContext('')
    expect(ctx).toBe(`${RESUME_INTERRUPTED_LEAD} Continue the work you were doing; re-run any pending action if needed.`)
    expect(ctx).toContain('user did NOT cancel')
  })

  it('with produced text: appends it and asks to continue without repeating', () => {
    const ctx = buildResumeInterruptionContext('partial output')
    expect(ctx).toContain('interrupted by a host update')
    expect(ctx).toContain('do not repeat it')
    expect(ctx).toContain('partial output')
  })
})

describe('collectTurnStreamText (A3 checkpoint continuation)', () => {
  it('folds assistant/chunk text of one turn in order', () => {
    const events: SessionEvent[] = [
      chunkEvent(1, 1, 'hel', 1),
      chunkEvent(1, 1, 'lo ', 2),
      chunkEvent(1, 1, 'world', 3),
      chunkEvent(2, 1, 'other-turn', 4),
      chunkEvent(1, 2, 'step2', 5),
    ]
    expect(collectTurnStreamText(events, 1)).toBe('hello worldstep2')
  })

  it('skips chunk rows without text and other event types', () => {
    const events: SessionEvent[] = [
      chunkEvent(1, 1, '', 1),
      { type: 'turn/start', seq: 2, time: 2, data: { turn: 1 } },
      chunkEvent(1, 1, 'ok', 3),
    ]
    expect(collectTurnStreamText(events, 1)).toBe('ok')
  })

  it('caps at RESUME_CONTEXT_TEXT_CAP (2000 chars)', () => {
    const long = 'x'.repeat(5000)
    expect(collectTurnStreamText([chunkEvent(1, 1, long, 1)], 1).length).toBe(2000)
  })
})
