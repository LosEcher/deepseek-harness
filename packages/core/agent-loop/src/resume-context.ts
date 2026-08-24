/**
 * Resume interruption context (A2/A3, borrowed from grok-bot-0.18 quiesce
 * semantics).
 *
 * A `turn/pending` tail means the previous process instance left the turn
 * open: it was drained for a host update/restart or crashed — the user did
 * NOT cancel it. Injecting that fact into the first resumed step stops the
 * model from misreading an interruption as a user decision ("被打断而非被拒").
 *
 * A3 (checkpoint-continuation, pragmatic tier): when the interrupted step had
 * already produced streamed text (assistant/chunk rows), append it so the
 * model continues from where it ended instead of regenerating (and repeating)
 * the already-token-cost output.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Cap on how much already-produced text is echoed back into the model. */
export const RESUME_CONTEXT_TEXT_CAP = 2_000

export const RESUME_INTERRUPTED_LEAD =
  'Your previous turn was interrupted by a host update or restart — the user did NOT cancel it.'

/**
 * Build the system context for a resumed step.
 * @param alreadyProduced - streamed text from the interrupted step ('' when none).
 */
export function buildResumeInterruptionContext(alreadyProduced: string): string {
  if (alreadyProduced.length === 0) {
    return `${RESUME_INTERRUPTED_LEAD} Continue the work you were doing; re-run any pending action if needed.`
  }
  return (
    `${RESUME_INTERRUPTED_LEAD} You had already produced the text below; ` +
    `continue from where it ends and do not repeat it:\n\n${alreadyProduced}`
  )
}

/**
 * Collect the streamed text of one turn from the durable log
 * (`assistant/chunk` rows — chunks are trace rows, never projected into
 * derived history, so resume needs this explicit fold).
 */
export function collectTurnStreamText(events: readonly SessionEvent[], turn: number): string {
  const parts: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/chunk') continue
    if (event.data.turn !== turn) continue
    const chunk = event.data.chunk as { text?: unknown } | undefined
    if (typeof chunk?.text === 'string' && chunk.text.length > 0) parts.push(chunk.text)
  }
  return parts.join('').slice(0, RESUME_CONTEXT_TEXT_CAP)
}
