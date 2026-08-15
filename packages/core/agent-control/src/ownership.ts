/**
 * Event-stream session ownership (lease candidate B).
 * @module @deepseek-ai/dsh-agent-control
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentControlError } from './errors.ts'
import { fixtureErrorText } from './errors.ts'
import type { SessionOwnership } from './types.ts'

/**
 * Last ownership record in a session log, if any.
 * @param events - committed session events in seq order.
 * @returns the last `session/ownership` data, or undefined when none exists.
 */
export function lastOwnership(events: readonly SessionEvent[]): SessionOwnership | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session/ownership') return event.data
  }
  return undefined
}

/**
 * Refuse a second acquirer while another generation still holds the writer role.
 * @param events - committed session events in seq order.
 * @param generation - generation that wants to acquire.
 */
export function assertCanAcquire(events: readonly SessionEvent[], generation: number): void {
  const current = lastOwnership(events)
  if (current === undefined || current.action === 'release') return
  if (current.generation === generation) return
  throw new AgentControlError('already-held', fixtureErrorText('already-held'))
}

/**
 * Whether `generation` currently holds the writer role.
 * @param events - committed session events in seq order.
 * @param generation - candidate writer generation.
 * @returns true when the last ownership record is an acquire for that generation.
 */
export function generationHoldsLease(events: readonly SessionEvent[], generation: number): boolean {
  const current = lastOwnership(events)
  return current !== undefined && current.action === 'acquire' && current.generation === generation
}
