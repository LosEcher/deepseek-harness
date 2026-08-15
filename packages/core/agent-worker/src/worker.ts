/**
 * One-Agent worker process. Speaks the product bridge on stdin/stdout.
 * @module @deepseek-ai/dsh-agent-worker
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  admitAgentWorkerFrame,
  AgentControlError,
  assertCanAcquire,
  fixtureErrorText,
  type AgentControlCreateOptions,
  type AgentControlMessage,
  type AgentControlResumeOptions,
  type AgentDescriptor,
} from '@deepseek-ai/dsh-agent-control'
import {
  encodeFrame,
  FrameDecoder,
  isPriorityFrame,
  PROTOCOL_VERSION,
  validatePeerHello,
  type BridgeMessage,
  type Hello,
} from '@deepseek-ai/dsh-bridge-protocol'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { toUserMessage } from './messages.ts'

class FixtureAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const digest = process.env.DSH_AGENT_WORKER_DIGEST ?? ''
const build = process.env.DSH_AGENT_WORKER_BUILD ?? 'agent-worker'
const eventCredit = Number.parseInt(process.env.DSH_AGENT_WORKER_EVENT_CREDIT ?? '64', 10)
const sessionRoot = process.env.DSH_AGENT_WORKER_SESSION_ROOT

let generation = 0
let remainingCredit = Number.isInteger(eventCredit) ? eventCredit : 64
let ctx: Context | undefined
let handle: AgentHandle | undefined
let descriptor: AgentDescriptor | undefined
let owner = 'host'
const pendingEvents: BridgeMessage[] = []

const decoder = new FrameDecoder()

function send(message: BridgeMessage): void {
  process.stdout.write(encodeFrame(message))
}

function reply(id: string, result: unknown): void {
  send({ kind: 'reply', payload: { generation, id, result } })
}

function reject(id: string, error: AgentControlError): void {
  send({
    kind: 'error',
    payload: {
      generation,
      id,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.code === 'busy',
        cancelled: false,
      },
    },
  })
}

async function boot(): Promise<Context> {
  const next = new Context()
  await next.plugin(LlmRuntime)
  await next.plugin(SessionStore)
  await next.plugin(SystemPrompt)
  await next.plugin(ToolRuntime)
  await next.plugin(AgentRegistry)
  await next.plugin(AgentLoop, { agents: [] })
  if (sessionRoot !== undefined) {
    await next.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
  }
  next.llm.registerAdapter(['mock'], new FixtureAdapter())
  return next
}

function emitSessionEvent(seq: number, event: unknown): void {
  const frame: BridgeMessage = {
    kind: 'event_invoke',
    payload: {
      generation,
      id: `evt-${seq}`,
      event: 'session/event',
      payload: { seq, event },
      dispatch: 'emit',
    },
  }
  if (remainingCredit <= 0) {
    pendingEvents.push(frame)
    return
  }
  remainingCredit -= 1
  send(frame)
}

async function handleCall(message: Extract<BridgeMessage, { kind: 'call' }>): Promise<void> {
  try {
    admitAgentWorkerFrame(message, generation)
    const { id, method, args } = message.payload
    const body = isRecord(args) ? args : {}
    if (method === 'create') {
      if (handle !== undefined) throw new AgentControlError('already-held', fixtureErrorText('already-held'))
      ctx = await boot()
      const options = body.options as AgentControlCreateOptions
      owner = typeof body.owner === 'string' ? body.owner : 'host'
      handle = await ctx.agents.create({
        sessionId: SessionId(String(options.sessionId)),
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
      })
      bindAgent(handle.agent)
      assertCanAcquire(handle.agent.session.events, generation)
      handle.agent.session.append('session/ownership', {
        generation,
        action: 'acquire',
        backend: 'worker-ts',
        owner,
      })
      descriptor = {
        id: handle.agent.id,
        generation,
        backend: 'worker-ts',
        status: handle.agent.status,
        phase: 'ready',
        configDigest: digest,
      }
      reply(id, descriptor)
      return
    }
    if (method === 'resume') {
      if (handle !== undefined) throw new AgentControlError('already-held', fixtureErrorText('already-held'))
      ctx = await boot()
      const options = body.options as AgentControlResumeOptions
      owner = typeof body.owner === 'string' ? body.owner : 'host'
      handle = await ctx.agents.resume({
        resumeSessionId: SessionId(String(options.resumeSessionId)),
        ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
      })
      bindAgent(handle.agent)
      assertCanAcquire(handle.agent.session.events, generation)
      handle.agent.session.append('session/ownership', {
        generation,
        action: 'acquire',
        backend: 'worker-ts',
        owner,
      })
      descriptor = {
        id: handle.agent.id,
        generation,
        backend: 'worker-ts',
        status: handle.agent.status,
        phase: 'ready',
        configDigest: digest,
      }
      reply(id, descriptor)
      return
    }
    if (handle === undefined || descriptor === undefined) {
      throw new AgentControlError('unknown-agent', 'unknown agent')
    }
    if (method === 'send') {
      handle.agent.send(
        toUserMessage(body.message as AgentControlMessage),
        body.target === 'next-step' ? 'next-step' : 'next-turn',
        body.wakeup === true,
      )
      reply(id, null)
      return
    }
    if (method === 'followup') {
      handle.agent.followup(toUserMessage(body.message as AgentControlMessage))
      reply(id, null)
      return
    }
    if (method === 'steer') {
      handle.agent.steer(toUserMessage(body.message as AgentControlMessage))
      reply(id, null)
      return
    }
    if (method === 'inject') {
      handle.agent.inject(toUserMessage(body.message as AgentControlMessage))
      reply(id, null)
      return
    }
    if (method === 'cancel') {
      handle.agent.cancel(body.cause as AgentCancelCause, body.keepInbox === true ? { keepInbox: true } : undefined)
      reply(id, null)
      return
    }
    if (method === 'whenIdle') {
      await handle.agent.whenIdle()
      reply(id, null)
      return
    }
    if (method === 'flush') {
      if (ctx === undefined) throw new AgentControlError('unknown-agent', 'unknown agent')
      await ctx.sessions.flush(handle.agent.session)
      reply(id, null)
      return
    }
    if (method === 'drain') {
      await handle.agent.whenIdle()
      if (ctx !== undefined) await ctx.sessions.flush(handle.agent.session)
      handle.agent.session.append('session/ownership', {
        generation,
        action: 'release',
        backend: 'worker-ts',
        owner,
      })
      if (ctx !== undefined) await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
      handle = undefined
      descriptor = { ...descriptor, phase: 'drained', status: 'idle' }
      send({
        kind: 'event_invoke',
        payload: {
          generation,
          id: 'drained',
          event: 'agent/drained',
          payload: { agent: descriptor.id, generation },
          dispatch: 'emit',
        },
      })
      reply(id, null)
      return
    }
    if (method === 'get') {
      reply(id, descriptor)
      return
    }
    if (method === 'list' || method === 'roots') {
      reply(id, [descriptor])
      return
    }
    if (method === 'isOwnedBy') {
      reply(id, body.owner === owner)
      return
    }
    throw new AgentControlError('unknown-service', fixtureErrorText('unknown-service'))
  } catch (error) {
    const failure = error instanceof AgentControlError
      ? error
      : new AgentControlError('fault', error instanceof Error ? error.message : String(error))
    reject(message.payload.id, failure)
  }
}

function bindAgent(agent: Agent): void {
  agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    emitSessionEvent(event.seq, event)
  })
  agent.ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return
    if (descriptor !== undefined) descriptor = { ...descriptor, status }
    send({
      kind: 'event_invoke',
      payload: {
        generation,
        id: `status-${status}`,
        event: 'agent/status',
        payload: { agent: agent.id, status },
        dispatch: 'emit',
      },
    })
  })
}

function handleMessage(message: BridgeMessage): void {
  if (message.kind === 'hello') {
    generation = message.payload.generation
    const local: Hello = {
      bridge_version: PROTOCOL_VERSION,
      generation,
      role: 'node_worker',
      build,
      schema_digest: digest,
      capabilities: ['agent-worker'],
    }
    validatePeerHello(local, message.payload, digest)
    send({ kind: 'hello', payload: local })
    send({
      kind: 'contribution_register',
      payload: { generation, id: 'agent-worker', plugin: 'agent-worker', service: 'agent' },
    })
    return
  }
  if (message.kind === 'stream_credit') {
    remainingCredit += message.payload.credit_bytes
    while (remainingCredit > 0 && pendingEvents.length > 0) {
      const next = pendingEvents.shift()
      if (next === undefined) break
      remainingCredit -= 1
      send(next)
    }
    return
  }
  if (message.kind === 'dispose') {
    send({ kind: 'quiescent', payload: { generation } })
    process.exit(0)
  }
  if (message.kind === 'call') {
    void handleCall(message)
    return
  }
  if (message.kind === 'cancel' && handle !== undefined) {
    handle.agent.cancel({ kind: 'user' })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

process.stdin.on('data', (chunk: Buffer) => {
  const messages = decoder.push(chunk)
  const ordered = [
    ...messages.filter(isPriorityFrame),
    ...messages.filter(message => !isPriorityFrame(message)),
  ]
  for (const message of ordered) handleMessage(message)
})
process.stdin.resume()
