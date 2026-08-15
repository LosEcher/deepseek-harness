/**
 * One-child-per-Agent supervisor for worker-ts.
 * @module @deepseek-ai/dsh-agent-worker
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  admitAgentWorkerFrame,
  AgentControlError,
  type AgentControlCreateOptions,
  type AgentControlMessage,
  type AgentControlResumeOptions,
  type AgentDescriptor,
} from '@deepseek-ai/dsh-agent-control'
import { PROTOCOL_VERSION, validatePeerHello, type Hello } from '@deepseek-ai/dsh-bridge-protocol'
import type { AgentCancelCause, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'
import { BridgeConnection } from './connection.ts'

const MANIFEST_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../../agent/contracts/agent-worker-manifest-source.json')

/** Digest of the checked-in worker-protocol source manifest. */
export function agentWorkerManifestDigest(): string {
  return `sha256:${createHash('sha256').update(readFileSync(MANIFEST_SOURCE)).digest('hex')}`
}

/** One supervised worker generation. */
interface WorkerRecord {
  descriptor: AgentDescriptor
  owner: string
  child: ChildProcess
  connection: BridgeConnection
  queueDepth: number
  ready: Promise<void>
}

/** Main-process supervisor that speaks the worker protocol over stdio. */
export class WorkerSupervisor {
  private nextGeneration = 1
  private readonly records = new Map<SessionId, WorkerRecord>()
  private readonly digest = agentWorkerManifestDigest()

  /**
   * @param config - validated provider config.
   */
  constructor(private readonly config: Config) {}

  /**
   * Spawn a worker and create a session inside it.
   * @param owner - recorded owner identity.
   * @param options - serializable create fields.
   * @returns the published descriptor after ready.
   */
  async create(owner: string, options: AgentControlCreateOptions): Promise<AgentDescriptor> {
    this.admit('create', options.sessionId)
    const record = await this.spawn(owner, options.sessionId)
    const descriptor = await record.connection.call('agent', 'create', { owner, options }) as AgentDescriptor
    record.descriptor = { ...descriptor, backend: 'worker-ts', phase: 'ready' }
    return record.descriptor
  }

  /**
   * Spawn a worker and resume a persisted session inside it.
   * @param owner - recorded owner identity.
   * @param options - serializable resume fields.
   * @returns the published descriptor after ready.
   */
  async resume(owner: string, options: AgentControlResumeOptions): Promise<AgentDescriptor> {
    this.admit('resume', options.resumeSessionId)
    const record = await this.spawn(owner, options.resumeSessionId)
    const descriptor = await record.connection.call('agent', 'resume', { owner, options }) as AgentDescriptor
    record.descriptor = { ...descriptor, backend: 'worker-ts', phase: 'ready' }
    return record.descriptor
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   * @param target - inbox boundary.
   * @param wakeup - whether to wake the driver.
   */
  async send(id: SessionId, message: AgentControlMessage, target: 'next-turn' | 'next-step', wakeup: boolean): Promise<void> {
    await this.call(id, 'send', { message, target, wakeup })
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   */
  async followup(id: SessionId, message: AgentControlMessage): Promise<void> {
    await this.call(id, 'followup', { message })
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   */
  async steer(id: SessionId, message: AgentControlMessage): Promise<void> {
    await this.call(id, 'steer', { message })
  }

  /**
   * @param id - target agent.
   * @param message - control-plane message.
   */
  async inject(id: SessionId, message: AgentControlMessage): Promise<void> {
    await this.call(id, 'inject', { message })
  }

  /**
   * @param id - target agent.
   * @param cause - cancel cause.
   * @param keepInbox - preserve queued work when true.
   */
  async cancel(id: SessionId, cause: AgentCancelCause, keepInbox?: boolean): Promise<void> {
    await this.call(id, 'cancel', { cause, keepInbox })
  }

  /**
   * @param id - target agent.
   */
  async whenIdle(id: SessionId): Promise<void> {
    await this.call(id, 'whenIdle', {})
  }

  /**
   * @param id - target agent.
   */
  async flush(id: SessionId): Promise<void> {
    await this.call(id, 'flush', {}, 'session')
  }

  /**
   * @param id - target agent.
   */
  async drain(id: SessionId): Promise<void> {
    const record = this.require(id, 'drain')
    await record.connection.call('agent', 'drain', {})
    record.connection.send({ kind: 'dispose', payload: { generation: record.descriptor.generation } })
    await this.waitExit(record)
    record.descriptor = { ...record.descriptor, phase: 'drained', status: 'idle' }
  }

  /**
   * @param id - target agent.
   */
  async dispose(id: SessionId): Promise<void> {
    const record = this.records.get(id)
    if (record === undefined) return
    if (record.descriptor.phase !== 'drained') {
      try {
        await this.drain(id)
      } catch {
        record.child.kill('SIGKILL')
      }
    }
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
   * @returns descriptors owned by host.
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

  /**
   * Last-resort termination of one worker process. The generation becomes
   * faulted; resume is a new generation after the caller observes the fault.
   * @param id - target agent.
   */
  kill(id: SessionId): void {
    const record = this.records.get(id)
    if (record === undefined) return
    record.child.kill('SIGKILL')
  }

  /** Kill every child during plugin teardown. */
  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.records.keys()].map(id => this.dispose(id)))
  }

  private async call(id: SessionId, method: string, args: unknown, service = 'agent'): Promise<unknown> {
    const record = this.require(id, method)
    record.queueDepth += 1
    try {
      const result = await record.connection.call(service, method, args)
      if (method === 'whenIdle' || method === 'cancel') {
        record.descriptor = { ...record.descriptor, status: 'idle' }
      }
      return result
    } finally {
      record.queueDepth = Math.max(0, record.queueDepth - 1)
    }
  }

  private require(id: SessionId, method: string): WorkerRecord {
    this.admit(method, id)
    const record = this.records.get(id)
    if (record === undefined) throw new AgentControlError('unknown-agent', 'unknown agent')
    if (record.descriptor.phase !== 'ready') {
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

  private async spawn(owner: string, id: SessionId): Promise<WorkerRecord> {
    const generation = this.nextGeneration
    this.nextGeneration += 1
    const child = spawn(process.execPath, workerArgs(), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_AGENT_WORKER_DIGEST: this.digest,
        DSH_AGENT_WORKER_BUILD: 'agent-worker',
        DSH_AGENT_WORKER_EVENT_CREDIT: String(this.config.eventCredit),
        DSH_AGENT_WORKER_REPLAY_WINDOW: String(this.config.replayWindow),
        ...this.config.sessionRoot === undefined ? {} : { DSH_AGENT_WORKER_SESSION_ROOT: this.config.sessionRoot },
      },
    })
    if (child.stdin === null || child.stdout === null) {
      child.kill('SIGKILL')
      throw new AgentControlError('fault', 'worker stdio is unavailable')
    }
    const connection = new BridgeConnection(child.stdout, child.stdin, generation)
    const localHello: Hello = {
      bridge_version: PROTOCOL_VERSION,
      generation,
      role: 'node_root',
      build: 'agent-worker',
      schema_digest: this.digest,
      capabilities: ['agent-worker'],
    }
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AgentControlError('fault', 'worker ready timed out')), 15_000)
      const stop = connection.onMessage((message) => {
        if (message.kind !== 'hello') return
        try {
          validatePeerHello(localHello, message.payload, this.digest, ['agent-worker'])
          clearTimeout(timer)
          stop()
          resolve()
        } catch (error) {
          clearTimeout(timer)
          stop()
          reject(error)
        }
      })
    })
    connection.send({ kind: 'hello', payload: localHello })
    const descriptor: AgentDescriptor = {
      id,
      generation,
      backend: 'worker-ts',
      status: 'idle',
      phase: 'ready',
      configDigest: this.digest,
    }
    const record: WorkerRecord = { descriptor, owner, child, connection, queueDepth: 0, ready }
    this.records.set(id, record)
    child.once('exit', (code, signal) => {
      if (record.descriptor.phase === 'ready') {
        record.descriptor = { ...record.descriptor, phase: 'faulted' }
        connection.failPending(new AgentControlError('fault', `worker exited (${code ?? signal ?? 'unknown'})`))
      }
    })
    await ready
    connection.send({
      kind: 'stream_credit',
      payload: { generation, id: 'session-event', credit_bytes: this.config.eventCredit },
    })
    return record
  }

  private waitExit(record: WorkerRecord): Promise<void> {
    if (record.child.exitCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      record.child.once('exit', () => resolve())
    })
  }
}

function workerArgs(): string[] {
  if (import.meta.url.endsWith('.ts')) {
    return ['--import', 'tsx/esm', fileURLToPath(new URL('./worker.ts', import.meta.url))]
  }
  return [fileURLToPath(new URL('./types/worker.js', import.meta.url))]
}
