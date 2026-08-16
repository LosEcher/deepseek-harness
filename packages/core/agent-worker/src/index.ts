/**
 * local-ts and worker-ts provider for `ctx.agentControl`.
 * @module @deepseek-ai/dsh-agent-worker
 */

import { Context } from '@deepseek-ai/cordis'
import AgentControl, {
  type AgentControlCreateOptions,
  type AgentControlMessage,
  type AgentControlNotification,
  type AgentControlResumeOptions,
  type AgentDescriptor,
} from '@deepseek-ai/dsh-agent-control'
import type { AgentCancelCause, SessionId } from '@deepseek-ai/dsh-session'
import { Config } from './config.ts'
import { LocalAgentRuntime } from './local.ts'
import { WorkerSupervisor } from './supervisor.ts'

export { Config } from './config.ts'
export { agentWorkerManifestDigest, WorkerSupervisor } from './supervisor.ts'

type Runtime = LocalAgentRuntime | WorkerSupervisor

/**
 * Agent control provider. `backend` selects local-ts or worker-ts when the
 * plugin loads; it is never a hidden fallback.
 */
export default class AgentWorker extends AgentControl {
  static inject = {
    agents: { required: false },
    sessions: { required: false },
  }

  static Config = Config

  private readonly runtime: Runtime
  private readonly resolved: Config

  /**
   * @param ctx - host context.
   * @param config - validated provider configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.resolved = config
    if (config.backend === 'local-ts') {
      const agents = ctx.get('agents')
      const sessions = ctx.get('sessions')
      if (agents === undefined || sessions === undefined) {
        throw new Error('local-ts agent control requires ctx.agents and ctx.sessions')
      }
      this.runtime = new LocalAgentRuntime(agents, sessions, config)
    } else {
      this.runtime = new WorkerSupervisor(config)
    }
    ctx.effect(() => () => {
      void this.runtime.disposeAll()
    })
  }

  /**
   * Configured backend for this plugin instance.
   * @returns the explicit backend selected at load.
   */
  get backend(): Config['backend'] {
    return this.resolved.backend
  }

  override create(owner: string, options: AgentControlCreateOptions): Promise<AgentDescriptor> {
    return this.runtime.create(owner, options)
  }

  override resume(owner: string, options: AgentControlResumeOptions): Promise<AgentDescriptor> {
    return this.runtime.resume(owner, options)
  }

  override send(id: SessionId, message: AgentControlMessage, target: 'next-turn' | 'next-step', wakeup: boolean): Promise<void> {
    return this.runtime.send(id, message, target, wakeup)
  }

  override followup(id: SessionId, message: AgentControlMessage): Promise<void> {
    return this.runtime.followup(id, message)
  }

  override steer(id: SessionId, message: AgentControlMessage): Promise<void> {
    return this.runtime.steer(id, message)
  }

  override inject(id: SessionId, message: AgentControlMessage): Promise<void> {
    return this.runtime.inject(id, message)
  }

  override cancel(id: SessionId, cause: { readonly kind: string; readonly reason?: string }, keepInbox?: boolean): Promise<void> {
    return this.runtime.cancel(id, cause as AgentCancelCause, keepInbox)
  }

  override whenIdle(id: SessionId): Promise<void> {
    return this.runtime.whenIdle(id)
  }

  override flush(id: SessionId): Promise<void> {
    return this.runtime.flush(id)
  }

  override drain(id: SessionId): Promise<void> {
    return this.runtime.drain(id)
  }

  override dispose(id: SessionId): Promise<void> {
    return this.runtime.dispose(id)
  }

  override onNotification(listener: (notification: AgentControlNotification) => void): () => void {
    return this.runtime.onNotification(listener)
  }

  override invokeHost(id: SessionId, namespace: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    return this.runtime.invokeHost(id, namespace, method, args)
  }

  override invokeApiProxy(id: SessionId, section: string, method: string, args: readonly unknown[]): Promise<unknown> {
    return this.runtime.invokeApiProxy(id, section, method, args)
  }

  override get(id: SessionId): AgentDescriptor | undefined {
    return this.runtime.get(id)
  }

  override list(): AgentDescriptor[] {
    return this.runtime.list()
  }

  override roots(): AgentDescriptor[] {
    return this.runtime.roots()
  }

  override isOwnedBy(id: SessionId, owner: string): boolean {
    return this.runtime.isOwnedBy(id, owner)
  }
}
