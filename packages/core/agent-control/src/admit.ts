/**
 * Admission rules for Agent-worker frames. Shared by local-ts, worker-ts,
 * and the fixture corpus.
 * @module @deepseek-ai/dsh-agent-control
 */

import type { BridgeMessage } from '@deepseek-ai/dsh-bridge-protocol'
import { AgentControlError } from './errors.ts'
import { fixtureErrorText } from './errors.ts'

/** Services the worker protocol admits. */
export const AGENT_WORKER_SERVICES = new Set(['agent', 'session', 'host'])

/** Command methods on the agent service. */
export const AGENT_COMMANDS = new Set([
  'create',
  'resume',
  'send',
  'followup',
  'steer',
  'inject',
  'cancel',
  'whenIdle',
  'get',
  'list',
  'roots',
  'isOwnedBy',
  'drain',
])

/** Command methods on the host service (worker-local Host dispatch). */
export const HOST_COMMANDS = new Set(['invoke', 'apiProxy'])

/** Default bounded replay window when a resume omits one. */
export const DEFAULT_REPLAY_WINDOW = 1024

/**
 * Admit one worker-protocol frame against the live generation and queue bound.
 * @param message - decoded bridge message.
 * @param liveGeneration - current generation, or undefined before the first ready.
 * @param queueDepth - current per-agent command queue occupancy.
 * @param queueLimit - configured command queue bound.
 */
export function admitAgentWorkerFrame(
  message: BridgeMessage,
  liveGeneration: number | undefined,
  queueDepth = 0,
  queueLimit = 32,
): void {
  const generation = message.payload.generation
  if (generation === 0 || (liveGeneration !== undefined && generation !== liveGeneration)) {
    throw new AgentControlError('generation-retired', fixtureErrorText('generation-retired'))
  }
  if (message.kind === 'call') {
    if (!AGENT_WORKER_SERVICES.has(message.payload.service)) {
      throw new AgentControlError('unknown-service', fixtureErrorText('unknown-service'))
    }
    if (message.payload.service === 'host' && !HOST_COMMANDS.has(message.payload.method)) {
      throw new AgentControlError('unknown-service', fixtureErrorText('unknown-service'))
    }
    if (message.payload.method === 'runMaintenance') {
      throw new AgentControlError('functions-never-cross', fixtureErrorText('functions-never-cross'))
    }
    const args = isRecord(message.payload.args) ? message.payload.args : undefined
    const options = args && isRecord(args.options) ? args.options : undefined
    if (
      (message.payload.method === 'resume' || message.payload.method === 'create')
      && options !== undefined
      && 'replayWindow' in options
    ) {
      const window = options.replayWindow
      if (typeof window !== 'number' || !Number.isInteger(window) || window <= 0) {
        throw new AgentControlError('replay-unbounded', fixtureErrorText('replay-unbounded'))
      }
    }
    if (queueDepth >= queueLimit && message.payload.method !== 'cancel') {
      throw new AgentControlError('busy', fixtureErrorText('busy'))
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
