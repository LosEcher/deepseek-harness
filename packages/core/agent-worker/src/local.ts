/**
 * local-ts adapter: the in-process AgentRegistry behind AgentControl.
 * @module @deepseek-ai/dsh-agent-worker
 */

import type AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CancelOptions } from '@deepseek-ai/dsh-agent'
import {
  admitAgentWorkerFrame,
  AgentControlError,
  assertCanAcquire,
  type AgentControlCreateOptions,
  type AgentControlMessage,
  type AgentControlResumeOptions,
  type AgentDescriptor,
} from '@deepseek-ai/dsh-agent-control'
import type { AgentCancelCause, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'
import { toUserMessage } from './messages.ts'

/** One live local-ts generation. */
interface LocalRecord {
  descriptor: AgentDescriptor
  handle: AgentHandle
  owner: string
  queueDepth: number
}

/** In-process implementation of AgentControl over `ctx.agents`. */
export class LocalAgentRuntime {
  private nextGeneration = 1
  private readonly records = new Map<SessionId, LocalRecord>()

  /**
   * @param agents - live in-process registry.
   * @param sessions - session store used for flush.
   * @param config - validated provider config.
   */
  constructor(
    private readonly agents: AgentRegistry,
    private readonly sessions: { flush(session: Agent['session']): Promise<unknown> },
    private readonly config: Config,
  ) {}

  /**
   * Create a new in-process generation.
   * @param owner - recorded owner identity.
   * @param options - serializable create fields.
   * @returns the published descriptor.
   */
  async create(owner: string, options: AgentControlCreateOptions): Promise<AgentDescriptor> {
    this.admit('create', options.sessionId)
    const generation = this.nextGeneration
    this.nextGeneration += 1
    const handle = await this.agents.create({
      sessionId: options.sessionId,
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
    })
    assertCanAcquire(handle.agent.session.events, generation)
    handle.agent.session.append('session/ownership', {
      generation,
      action: 'acquire',
      backend: 'local-ts',
      owner,
    })
    const descriptor: AgentDescriptor = {
      id: handle.agent.id,
      generation,
      backend: 'local-ts',
      status: handle.agent.status,
      phase: 'ready',
      configDigest: 'local-ts',
    }
    this.records.set(handle.agent.id, { descriptor, handle, owner, queueDepth: 0 })
    return descriptor
  }

  /**
   * Resume a persisted session as a new in-process generation.
   * @param owner - recorded owner identity.
   * @param options - serializable resume fields.
   * @returns the published descriptor.
   */
  async resume(owner: string, options: AgentControlResumeOptions): Promise<AgentDescriptor> {
    this.admit('resume', options.resumeSessionId)
    const generation = this.nextGeneration
    this.nextGeneration += 1
    const handle = await this.agents.resume({
      resumeSessionId: options.resumeSessionId,
      ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
    })
    assertCanAcquire(handle.agent.session.events, generation)
    handle.agent.session.append('session/ownership', {
      generation,
      action: 'acquire',
      backend: 'local-ts',
      owner,
    })
    const descriptor: AgentDescriptor = {
      id: handle.agent.id,
      generation,
      backend: 'local-ts',
      status: handle.agent.status,
      phase: 'ready',
      configDigest: 'local-ts',
    }
    this.records.set(handle.agent.id, { descriptor, handle, owner, queueDepth: 0 })
    return descriptor
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   * @param target - inbox boundary.
   * @param wakeup - whether to wake the driver.
   */
  async send(id: SessionId, message: AgentControlMessage, target: 'next-turn' | 'next-step', wakeup: boolean): Promise<void> {
    const record = this.require(id, 'send')
    record.handle.agent.send(toUserMessage(message), target, wakeup)
    this.syncStatus(record)
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   */
  async followup(id: SessionId, message: AgentControlMessage): Promise<void> {
    const record = this.require(id, 'followup')
    record.handle.agent.followup(toUserMessage(message))
    this.syncStatus(record)
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   */
  async steer(id: SessionId, message: AgentControlMessage): Promise<void> {
    const record = this.require(id, 'steer')
    record.handle.agent.steer(toUserMessage(message))
    this.syncStatus(record)
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   */
  async inject(id: SessionId, message: AgentControlMessage): Promise<void> {
    const record = this.require(id, 'inject')
    record.handle.agent.inject(toUserMessage(message))
    this.syncStatus(record)
  }

  /**
   * @param id - target agent.
   * @param cause - cancel cause.
   * @param keepInbox - preserve queued work when true.
   */
  async cancel(id: SessionId, cause: AgentCancelCause, keepInbox?: boolean): Promise<void> {
    const record = this.require(id, 'cancel')
    const options: CancelOptions | undefined = keepInbox === undefined ? undefined : { keepInbox }
    record.handle.agent.cancel(cause, options)
    this.syncStatus(record)
  }

  /**
   * @param id - target agent.
   */
  async whenIdle(id: SessionId): Promise<void> {
    const record = this.require(id, 'whenIdle')
    await record.handle.agent.whenIdle()
    this.syncStatus(record)
  }

  /**
   * @param id - target agent.
   */
  async flush(id: SessionId): Promise<void> {
    const record = this.require(id, 'flush')
    await this.sessions.flush(record.handle.agent.session)
  }

  /**
   * @param id - target agent.
   */
  async drain(id: SessionId): Promise<void> {
    const record = this.require(id, 'drain')
    await record.handle.agent.whenIdle()
    await this.sessions.flush(record.handle.agent.session)
    record.handle.agent.session.append('session/ownership', {
      generation: record.descriptor.generation,
      action: 'release',
      backend: 'local-ts',
      owner: record.owner,
    })
    await this.sessions.flush(record.handle.agent.session)
    await record.handle.dispose()
    record.descriptor = { ...record.descriptor, phase: 'drained', status: 'idle' }
  }

  /**
   * @param id - target agent.
   */
  async dispose(id: SessionId): Promise<void> {
    const record = this.records.get(id)
    if (record === undefined) return
    if (record.descriptor.phase !== 'drained') await this.drain(id)
    this.records.delete(id)
  }

  /**
   * @param id - target agent.
   * @returns the descriptor, or undefined.
   */
  get(id: SessionId): AgentDescriptor | undefined {
    return this.records.get(id)?.descriptor
  }

  /**
   * @returns every tracked descriptor.
   */
  list(): AgentDescriptor[] {
    return [...this.records.values()].map(record => record.descriptor)
  }

  /**
   * @returns descriptors whose owner is empty or `host`.
   */
  roots(): AgentDescriptor[] {
    return [...this.records.values()]
      .filter(record => record.owner === 'host' || record.owner.length === 0)
      .map(record => record.descriptor)
  }

  /**
   * @param id - candidate agent.
   * @param owner - owner identity.
   * @returns whether the live record names that owner.
   */
  isOwnedBy(id: SessionId, owner: string): boolean {
    return this.records.get(id)?.owner === owner
  }

  /** Dispose every live handle during plugin teardown. */
  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.records.keys()].map(id => this.dispose(id)))
  }

  private require(id: SessionId, method: string): LocalRecord {
    this.admit(method, id)
    const record = this.records.get(id)
    if (record === undefined) throw new AgentControlError('unknown-agent', 'unknown agent')
    if (record.descriptor.phase !== 'ready' && method !== 'drain' && method !== 'dispose') {
      throw new AgentControlError('generation-retired', 'generation retired')
    }
    return record
  }

  private admit(method: string, id: SessionId): void {
    const record = this.records.get(id)
    admitAgentWorkerFrame({
      kind: 'call',
      payload: {
        generation: record?.descriptor.generation ?? (method === 'create' || method === 'resume' ? this.nextGeneration : 0),
        id: method,
        service: method === 'flush' ? 'session' : 'agent',
        method,
        args: {},
      },
    }, record?.descriptor.generation ?? (method === 'create' || method === 'resume' ? this.nextGeneration : undefined), record?.queueDepth ?? 0, this.config.commandQueueLimit)
  }

  private syncStatus(record: LocalRecord): void {
    record.descriptor = { ...record.descriptor, status: record.handle.agent.status }
  }
}
