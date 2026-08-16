/**
 * Process-safe Agent control Service Definition (`ctx.agentControl`).
 * Callers never receive a live `Agent`; they hold {@link AgentDescriptor}
 * records and issue named commands.
 * @module @deepseek-ai/dsh-agent-control
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AgentControlCreateOptions,
  AgentControlMessage,
  AgentControlNotification,
  AgentControlResumeOptions,
  AgentDescriptor,
} from './types.ts'

export type {
  AgentBackend,
  AgentControlCreateOptions,
  AgentControlErrorCode,
  AgentControlMessage,
  AgentControlNotification,
  AgentControlPhase,
  AgentControlResumeOptions,
  AgentDescriptor,
  SessionOwnership,
} from './types.ts'
export { AgentControlError, fixtureErrorText } from './errors.ts'
export {
  admitAgentWorkerFrame,
  AGENT_COMMANDS,
  AGENT_WORKER_SERVICES,
  DEFAULT_REPLAY_WINDOW,
  HOST_COMMANDS,
} from './admit.ts'
export { assertCanAcquire, generationHoldsLease, lastOwnership } from './ownership.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentControl: AgentControl
  }
}

/**
 * Abstract Agent control service. Implementations own backend selection,
 * generation issue, command admission, and the session-ownership appends.
 * Load one implementation per context as `ctx.agentControl`.
 */
export default abstract class AgentControl extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentControl')
  }

  /**
   * Create a new generation on a caller-supplied session id.
   * @param owner - process-visible owner identity recorded on the acquire event.
   * @param options - identity, backend, and serializable creation fields.
   * @returns the published descriptor after the worker reports ready.
   */
  abstract create(owner: string, options: AgentControlCreateOptions): Promise<AgentDescriptor>

  /**
   * Resume a persisted session as a new generation.
   * @param owner - process-visible owner identity recorded on the acquire event.
   * @param options - persisted identity, backend, and serializable resume fields.
   * @returns the published descriptor after the worker reports ready.
   */
  abstract resume(owner: string, options: AgentControlResumeOptions): Promise<AgentDescriptor>

  /**
   * Route identified input to an inbox boundary.
   * @param id - target agent.
   * @param message - JSON-serializable user message.
   * @param target - preferred inbox boundary.
   * @param wakeup - whether delivery may wake the driver.
   */
  abstract send(id: SessionId, message: AgentControlMessage, target: 'next-turn' | 'next-step', wakeup: boolean): Promise<void>

  /**
   * Queue an ordinary follow-up turn.
   * @param id - target agent.
   * @param message - JSON-serializable user message.
   */
  abstract followup(id: SessionId, message: AgentControlMessage): Promise<void>

  /**
   * Submit steering for the nearest step.
   * @param id - target agent.
   * @param message - JSON-serializable user message.
   */
  abstract steer(id: SessionId, message: AgentControlMessage): Promise<void>

  /**
   * Queue model-facing context without waking the driver.
   * @param id - target agent.
   * @param message - JSON-serializable user message.
   */
  abstract inject(id: SessionId, message: AgentControlMessage): Promise<void>

  /**
   * Cancel the active turn. Idempotent.
   * @param id - target agent.
   * @param cause - JSON-serializable cancel cause.
   * @param keepInbox - when true, preserve queued work.
   */
  abstract cancel(id: SessionId, cause: { readonly kind: string; readonly reason?: string }, keepInbox?: boolean): Promise<void>

  /**
   * Resolve after drained-strength quiescence.
   * @param id - target agent.
   */
  abstract whenIdle(id: SessionId): Promise<void>

  /**
   * Flush the session log through the persistence coordinator.
   * @param id - target agent.
   */
  abstract flush(id: SessionId): Promise<void>

  /**
   * Drain the generation: idle, flush, release the lease, and stop the worker.
   * @param id - target agent.
   */
  abstract drain(id: SessionId): Promise<void>

  /**
   * Dispose the generation and forget the descriptor.
   * @param id - target agent.
   */
  abstract dispose(id: SessionId): Promise<void>

  /**
   * Subscribe to main-process read-model notifications (committed session
   * events, status mirrors, drain reports) for every generation this provider
   * holds. Payloads are JSON-serializable values only; live `Session`/`Agent`
   * objects never appear here.
   * @param listener - notification observer.
   * @returns disposer that unsubscribes.
   */
  abstract onNotification(listener: (notification: AgentControlNotification) => void): () => void

  /**
   * Invoke one Host Remote method inside the generation's own composition —
   * the worker-local Host surface. worker-ts forwards through the worker's
   * typert gateway; local-ts holds agents in-process and rejects (Host
   * methods run directly there).
   * @param id - target agent whose composition owns the invocation.
   * @param namespace - Remote namespace selected by the generated descriptor.
   * @param method - exported Service method name.
   * @param args - named wire values.
   * @returns the validated business result.
   */
  abstract invokeHost(id: SessionId, namespace: string, method: string, args: Record<string, unknown>): Promise<unknown>

  /**
   * Read-model lookup.
   * @param id - target agent.
   * @returns the current descriptor, or undefined when unknown.
   */
  abstract get(id: SessionId): AgentDescriptor | undefined

  /**
   * Read-model list of live descriptors.
   * @returns every descriptor this control service currently tracks.
   */
  abstract list(): AgentDescriptor[]

  /**
   * Read-model list of root descriptors (no owner).
   * @returns descriptors created without an owning agent.
   */
  abstract roots(): AgentDescriptor[]

  /**
   * Whether `id` was created under `owner`.
   * @param id - candidate agent.
   * @param owner - owner identity recorded at create/resume.
   * @returns true when the live descriptor names that owner.
   */
  abstract isOwnedBy(id: SessionId, owner: string): boolean
}
