/**
 * Crash-recovery repair for an interrupted session log. It preserves a fully
 * written final turn and supplies the missing tool, step, and turn boundaries
 * needed to resume with a provider-valid transcript.
 * @module @deepseek-ai/dsh-session/repair
 */

import { MessageId, freezeMessage, type CallId } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SurfaceEvent } from './types.ts'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * A tool call an assistant message ordered but whose durable `tool/result`
 * is missing from the log. `callSeq` is the `tool/call` event seq when the
 * call start was durably recorded; `undefined` means the call never reached
 * a recorded start.
 */
export interface DanglingToolCall {
  callId: CallId
  turn: number
  step: number
  /** The `tool/call` event seq, when the call start was durably recorded. */
  callSeq?: number
}

/** Append arguments for one synthesized `tool/result`, ready for `Session.append`. */
export interface ToolResultAppendSpec {
  type: 'tool/result'
  data: SessionEventMap['tool/result']
  surfaceOp: SurfaceEvent['surfaceOp']
  sourceEventSeqs?: number[]
}

/**
 * Scan the whole log for assistant-ordered tool calls with no durable
 * `tool/result` (dangling calls). Unlike crash-tail repair this crosses step
 * and turn boundaries: a call interrupted mid-flight by a drain fast-exit
 * leaves its assistant `tool-call` block in the log, and until a result is
 * synthesized every re-derived transcript fails provider validation
 * (an assistant message with `tool_calls` must be answered) — poisoning every
 * later request, not just the crash tail.
 */
export function scanDanglingToolCalls(events: readonly SessionEvent[]): DanglingToolCall[] {
  const pendingCalls = new Map<CallId, DanglingToolCall>()
  for (const event of events) {
    switch (event.type) {
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            pendingCalls.set(block.id, {
              callId: block.id,
              turn: event.data.turn,
              step: event.data.step,
            })
          }
        }
        break
      case 'tool/call': {
        const entry = pendingCalls.get(event.data.callId)
        if (entry !== undefined) entry.callSeq = event.seq
        break
      }
      case 'tool/result':
        pendingCalls.delete(event.data.message.source.callId)
        break
      default:
        break
    }
  }
  return [...pendingCalls.values()]
}

/**
 * Deterministic `tool/result` append specs answering a list of dangling tool
 * calls. Started calls receive the {@link TOOL_OUTCOME_UNKNOWN} recovery code
 * and a cautionary text; calls that never recorded a start receive
 * {@link TOOL_NOT_STARTED} with a retry hint. Message ids are derived from the
 * call identity so repeated synthesis is deterministic.
 */
export function danglingToolResultSpecs(dangling: readonly DanglingToolCall[]): ToolResultAppendSpec[] {
  return dangling.map(({ callId, turn, step, callSeq }) => {
    const started = callSeq !== undefined
    const message: ToolResultMessage = freezeMessage({
      id: MessageId(`interrupted-tool-result-${callId}-${turn}-${step}`),
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [{
          type: 'text',
          text: started
            ? 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
            : 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
        }],
      }],
    })
    return {
      type: 'tool/result',
      data: {
        turn,
        step,
        message,
        error: started
          ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
          : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      },
      surfaceOp: 'append',
      ...started ? { sourceEventSeqs: [callSeq] } : {},
    }
  })
}

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls receive error results first, followed by an open `step/end` and an
 * interrupted `turn/end`; sequences continue the log and timestamps reuse the
 * last real event. A balanced or empty log returns no events.
 *
 * @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
/** Open `turn/pending` tail a resumed driver continues instead of starting a new turn. */
export interface ResumablePendingTurn {
  turn: number
  openStep: number | null
  /** Step the driver opens after closing {@link openStep}, if any. */
  nextStep: number
}

/**
 * Return the open `turn/pending` tail when resume should continue that turn.
 * A balanced log, a crash tail without the marker, or a pending marker that
 * does not name the open turn yields `undefined` — crash repair then owns the log.
 * @param events - the loaded durable log (a valid committed prefix).
 * @returns the open pending turn, or `undefined` when resume must not continue one.
 */
export function resumablePendingTurn(events: readonly SessionEvent[]): ResumablePendingTurn | undefined {
  let openTurn: number | null = null
  let openStep: number | null = null
  let pendingTurn: number | null = null
  let nextStep = 1
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        pendingTurn = null
        nextStep = 1
        break
      case 'turn/pending':
        pendingTurn = event.data.turn
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pendingTurn = null
        nextStep = 1
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        nextStep = event.data.step + 1
        break
      default:
        break
    }
  }
  if (openTurn === null || pendingTurn !== openTurn) return undefined
  return {
    turn: openTurn,
    openStep,
    nextStep: openStep !== null ? openStep + 1 : nextStep,
  }
}

export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  // 方案 C: a turn the shutdown explicitly left open (turn/pending) is a
  // resumable tail, not a crash. Tracked per-turn — the fast-exit marker may
  // not be the LAST event, because the model stream keeps appending chunks
  // until the OS stops the process.
  let pendingTurn: number | null = null
  // Reset at each turn boundary so earlier calls cannot leak into tail repair.
  // Assistant blocks register calls; later `tool/call` events add their seqs to `sourceEventSeqs`.
  const pendingCalls = new Map<CallId, { step: number; callSeq?: number }>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        pendingTurn = null
        pendingCalls.clear()
        break
      case 'turn/pending':
        pendingTurn = event.data.turn
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pendingTurn = null
        pendingCalls.clear()
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        pendingCalls.clear()
        openStep = null
        break
      case 'assistant/message':
        // The assistant message carries the tool-call blocks; each is pending
        // until a tool/result event with the same callId is logged.
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') pendingCalls.set(block.id, { step: event.data.step })
        }
        break
      case 'tool/call':
        // Cite the `tool/call` seq from the synthetic result.
        {
          const entry = pendingCalls.get(event.data.callId)
          if (entry) {
            entry.callSeq = event.seq
          }
        }
        break
      case 'tool/result':
        pendingCalls.delete(event.data.message.source.callId)
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no crash mid-turn): nothing to close. An open turn implies
  // `events` is non-empty (its turn/start was logged), so `last` exists.
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  // 方案 C: a turn the shutdown explicitly left open (turn/pending anywhere
  // in its tail, not necessarily as the last event) is a resumable tail, not
  // a crash — do not synthesize `interrupted` closers for it.
  if (pendingTurn === openTurn) return []

  // The last real event supplies the seq base and the timestamp for the
  // synthetic closers (reusing the last timestamp keeps them deterministic and
  // never invents a "future" time).
  let seq = last.seq + 1
  const time = last.time
  const closers: SessionEvent[] = []

  // Close calls before their step: providers reject dangling assistant calls,
  // and Map insertion order preserves their transcript order. The synthesized
  // specs are shared with the agent-loop resume path, so crash repair and
  // resumption answer interrupted calls identically.
  const specs = danglingToolResultSpecs(
    [...pendingCalls].map(([callId, { step, callSeq }]) => ({
      callId,
      turn: openTurn,
      step,
      ...callSeq !== undefined ? { callSeq } : {},
    })),
  )
  for (const spec of specs) {
    closers.push({ ...spec, seq: seq++, time })
  }

  // Close an open step next — a turn/end while a step is open is an invariant
  // violation, so the step's boundary must be synthesized before the turn's.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
  return closers
}
