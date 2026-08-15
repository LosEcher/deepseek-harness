/**
 * Validated Agent control provider configuration.
 * @module @deepseek-ai/dsh-agent-worker
 */

import z from '@deepseek-ai/schemastery'
import type { AgentBackend } from '@deepseek-ai/dsh-agent-control'

/** Composition entry for the Agent control provider. */
export interface Config {
  /** Backend used for every generation this plugin starts. */
  backend: AgentBackend
  /** Maximum queued commands per agent before a typed busy error. */
  commandQueueLimit: number
  /** Unacknowledged session-event credit granted to the worker. */
  eventCredit: number
  /** Maximum durable events replayed on resume. */
  replayWindow: number
  /** Optional JSONL persistence root used by worker-ts drain-and-resume. */
  sessionRoot?: string
}

/** Schema for {@link Config}. */
export const Config: z<Config> = z.object({
  backend: z.union(['local-ts', 'worker-ts'] as const).default('local-ts'),
  commandQueueLimit: z.number().step(1).min(1).default(32),
  eventCredit: z.number().step(1).min(1).default(64),
  replayWindow: z.number().step(1).min(1).default(1024),
  sessionRoot: z.string(),
})
