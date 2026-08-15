/**
 * Typed Agent control failures.
 * @module @deepseek-ai/dsh-agent-control
 */

import type { AgentControlErrorCode } from './types.ts'

/** Control-plane failure suitable for a bridge `error` frame. */
export class AgentControlError extends Error {
  override readonly name = 'AgentControlError'

  /**
   * @param code - stable failure class.
   * @param message - diagnostic retained as the Error message.
   */
  constructor(readonly code: AgentControlErrorCode, message: string) {
    super(message)
  }
}

/**
 * Map a control error onto the P0 fixture expected_error text.
 * @param code - stable failure class.
 * @returns the fixture phrase used by the negative corpus.
 */
export function fixtureErrorText(code: AgentControlErrorCode): string {
  switch (code) {
    case 'generation-retired':
      return 'generation retired'
    case 'functions-never-cross':
      return 'functions never cross the boundary'
    case 'unknown-service':
      return 'unknown service'
    case 'replay-unbounded':
      return 'replay window must be bounded'
    case 'busy':
      return 'busy'
    case 'already-held':
      return 'already held'
    case 'unknown-agent':
      return 'unknown agent'
    case 'fault':
      return 'fault'
  }
}
