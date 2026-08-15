import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

interface Drainable {
  drainToIdle(timeoutMs: number): Promise<'idle' | 'pending' | 'timed-out'>
}

/** A script entry that answers after `delayMs`, so the turn sits in a model wait. */
function delayedTextResponse(delayMs: number, text = 'done'): () => AsyncGenerator<StreamChunk> {
  return async function* () {
    await new Promise<void>((resolve) => { setTimeout(resolve, delayMs) })
    yield* textResponse(text)
  }
}

async function harness(adapter: MockAdapter, persona = '') {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForStatus(ctx: Context, agent: Agent, status: 'idle' | 'running'): Promise<void> {
  return new Promise((resolve) => {
    if (agent.status === status) {
      resolve()
      return
    }
    const dispose = ctx.on('agent/status', ({ agent: subject, status: next }) => {
      if (subject === agent && next === status) {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('agent drain to turn boundary', () => {
  it('fast-exits a model-wait turn as pending with a resumable marker (方案 C)', async () => {
    const adapter = new MockAdapter([delayedTextResponse(60, 'done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('drain-pending-model'), { provider: 'mock', model: 'mock' })
    const running = waitForStatus(ctx, agent, 'running')
    send(agent, 'hello')
    await running
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // Model wait = no side effects: drain returns 'pending' immediately and
    // marks the open turn resumable instead of waiting or aborting it.
    const outcome = await (agent as unknown as Drainable).drainToIdle(5_000)
    expect(outcome).toBe('pending')
    const pending = agent.session.events.findLast(e => e.type === 'turn/pending')
    expect(pending?.type === 'turn/pending' ? pending.data.turn : undefined).toBe(1)
    // No turn/end was written: the turn stays open for post-resume rebuild.
    expect(agent.session.events.filter(e => e.type === 'turn/end')).toHaveLength(0)
    // The drain gate stays closed: waking input after draining must not open
    // a new turn; the message stays pending for post-resume handling.
    send(agent, 'after-drain')
    await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
    expect(agent.session.events.filter(e => e.type === 'turn/start')).toHaveLength(1)
  })

  it('fast-exits a hanging model stream as pending (no 30s wait for a stuck model)', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('drain-pending-hang'), { provider: 'mock', model: 'mock' })
    const running = waitForStatus(ctx, agent, 'running')
    send(agent, 'hello')
    await running
    // The model request is in flight (activity = model-wait) before draining.
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    const outcome = await (agent as unknown as Drainable).drainToIdle(100)
    expect(outcome).toBe('pending')
    // The hanging turn was NOT aborted by the drain: it stays open and
    // resumable; the caller skips the cancel path for pending.
    expect(agent.status).toBe('running')
  })

  it('shutdownDrain fast-exits every model-wait agent as pending (方案 C)', async () => {
    const adapter = new MockAdapter([delayedTextResponse(500, 'done-a'), delayedTextResponse(500, 'done-b')])
    const ctx = await harness(adapter)
    const a = await ctx.agentLoop.create(SessionId('drain-all-a'), { provider: 'mock', model: 'mock' })
    const b = await ctx.agentLoop.create(SessionId('drain-all-b'), { provider: 'mock', model: 'mock' })
    const aRunning = waitForStatus(ctx, a, 'running')
    const bRunning = waitForStatus(ctx, b, 'running')
    send(a, 'hello a')
    send(b, 'hello b')
    await Promise.all([aRunning, bRunning])
    // Both turns sit in their model wait.
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))

    // P0 flush 栅栏: shutdownDrain must flush every live session's
    // write-behind buffer (turn/pending included) before teardown, so the
    // next boot's crash repair sees the resumable marker.
    const flushed: string[] = []
    ctx.on('session/flush', (session: { id: string }) => void flushed.push(session.id))

    // Model waits have no side effects: both drain as 'pending' (safe). The
    // turn stays open for post-resume rebuild — or, if the model response
    // lands during teardown, it completes naturally (turn/end completed),
    // which is even better. Either way no interrupted synthesis applies.
    const ok = await ctx.agentLoop.shutdownDrain(5_000)
    expect(ok).toBe(true)
    expect(flushed).toEqual(expect.arrayContaining(['drain-all-a', 'drain-all-b']))
    for (const agent of [a, b]) {
      const ends = agent.session.events.filter(e => e.type === 'turn/end')
      if (ends.length > 0) {
        const last = ends.at(-1)
        expect(last?.type === 'turn/end' ? last.data.reason.kind : undefined).toBe('completed')
      }
      const pending = agent.session.events.findLast(e => e.type === 'turn/pending')
      expect(pending?.type === 'turn/pending' ? pending.data.turn : undefined).toBe(1)
    }
  })
})

describe('restart-coordination gates (markDraining / hasLiveActivity)', () => {
  it('resumeOpenTurn is a no-op without a pending tail', async () => {
    const ctx = await harness(new MockAdapter([textResponse('hi')]))
    const agent = ctx.agentLoop.create(SessionId('s-noop-resume'), { provider: 'mock', model: 'mock' }) as Agent & {
      resumeOpenTurn(): void
      hasPendingResume(): boolean
    }
    expect(agent.hasPendingResume()).toBe(false)
    agent.resumeOpenTurn()
    expect(agent.status).toBe('idle')
  })

  it('hasLiveActivity is false at idle and true while a turn is live', async () => {
    const ctx = await harness(new MockAdapter([textResponse('hi')]))
    const loop = ctx.agentLoop as unknown as { create(...args: unknown[]): Agent }
    const agent = loop.create('s1') as Agent & { markDraining(): void; hasLiveActivity(): boolean }
    const gated = agent as unknown as { markDraining(): void; hasLiveActivity(): boolean }
    expect(gated.hasLiveActivity()).toBe(false)
    send(agent, 'hello')
    await waitForStatus(ctx, agent, 'running')
    expect(gated.hasLiveActivity()).toBe(true)
    await waitForStatus(ctx, agent, 'idle')
    expect(gated.hasLiveActivity()).toBe(false)
  })

  it('markDraining is loop-level: agents created after it inherit the wake gate', async () => {
    const ctx = await harness(new MockAdapter([textResponse('should-not-run')]))
    const loop = ctx.agentLoop as unknown as {
      markDraining(): void
      create(...args: unknown[]): Agent & { hasLiveActivity(): boolean }
    }
    loop.markDraining()
    const agent = loop.create(SessionId('s-after-drain'), { provider: 'mock', model: 'mock' })
    send(agent, 'hello')
    await new Promise<void>((resolve) => { setTimeout(resolve, 80) })
    expect(agent.hasLiveActivity()).toBe(false)
    expect(agent.session.events.filter(e => e.type === 'turn/start')).toHaveLength(0)
  })

  it('hasBlockingActivity is true only while a tool is in flight', async () => {
    const ctx = await harness(new MockAdapter([
      toolCallResponse('c-block', 'slow', {}),
      textResponse('after-tool'),
    ]))
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    ctx.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'blocks until released',
      parameters: {},
      async execute() {
        await blocked
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    const loop = ctx.agentLoop as unknown as {
      hasBlockingActivity(): boolean
      create(...args: unknown[]): Agent
    }
    const agent = loop.create(SessionId('s-block'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    await vi.waitFor(() => expect(loop.hasBlockingActivity()).toBe(true))
    release()
    await waitForStatus(ctx, agent, 'idle')
    expect(loop.hasBlockingActivity()).toBe(false)
  })

  it('shutdownDrain logs a rejected session flush and still returns', async () => {
    const adapter = new MockAdapter([delayedTextResponse(60, 'done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('drain-flush-fail'), { provider: 'mock', model: 'mock' })
    const running = waitForStatus(ctx, agent, 'running')
    send(agent, 'hello')
    await running
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    ctx.on('session/flush', () => {
      throw new Error('flush-denied')
    })
    const ok = await ctx.agentLoop.shutdownDrain(5_000)
    expect(ok).toBe(true)
  })

  it('resume reports an error when closing the open step fails', async () => {
    const ctx = await harness(new MockAdapter([textResponse('unused')]))
    const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    ctx.on('agent/session-start', ({ agent }) => {
      const original = agent.session.append.bind(agent.session) as (type: string, data: unknown, extra?: unknown) => unknown
      agent.session.append = ((type: string, data: unknown, extra?: unknown) => {
        if (type === 'step/end') throw new Error('step-end-denied')
        return original(type, data, extra)
      }) as typeof agent.session.append
    })
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('pending-step-end-fail'),
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: user, surfaceOp: 'append' },
        { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
        { type: 'turn/pending', seq: 3, time: 4, data: { turn: 1 } },
      ],
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(agent.session.events.filter(event => event.type === 'step/end')).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('create on a turn/pending seed with no open step continues that turn', async () => {
    const ctx = await harness(new MockAdapter([textResponse('retried')]))
    const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('pending-closed-step'),
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: user, surfaceOp: 'append' },
        { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
        { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
        { type: 'turn/pending', seq: 4, time: 5, data: { turn: 1 } },
      ],
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await agent.whenIdle()
    expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(
      agent.session.events
        .filter(event => event.type === 'step/start')
        .map(event => event.type === 'step/start' ? event.data.step : undefined),
    ).toEqual([1, 2])
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' ? end.data : undefined).toMatchObject({
      turn: 1,
      reason: { kind: 'completed' },
    })
  })

  it('markPending warns when the session refuses the marker', async () => {
    const adapter = new MockAdapter([delayedTextResponse(60, 'done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('drain-pending-warn'), { provider: 'mock', model: 'mock' })
    const running = waitForStatus(ctx, agent, 'running')
    send(agent, 'hello')
    await running
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    const original = agent.session.append.bind(agent.session) as (type: string, data: unknown, extra?: unknown) => unknown
    agent.session.append = ((type: string, data: unknown, extra?: unknown) => {
      if (type === 'turn/pending') throw new Error('append-denied')
      return original(type, data, extra)
    }) as typeof agent.session.append
    const outcome = await (agent as unknown as Drainable).drainToIdle(5_000)
    expect(outcome).toBe('pending')
    expect(agent.session.events.some(event => event.type === 'turn/pending')).toBe(false)
  })

  it('markDraining refuses new turns after the in-flight one settles (wake gate)', async () => {
    const ctx = await harness(new MockAdapter([textResponse('first')]))
    const loop = ctx.agentLoop as unknown as { create(...args: unknown[]): Agent }
    const agent = loop.create('s2') as Agent & { markDraining(): void; hasLiveActivity(): boolean }
    const gated = agent as unknown as { markDraining(): void; hasLiveActivity(): boolean }
    send(agent, 'first')
    await waitForStatus(ctx, agent, 'idle')
    gated.markDraining()
    // A follow-up arrives while draining: the wake is refused, no new turn starts.
    send(agent, 'second')
    await new Promise<void>((resolve) => { setTimeout(resolve, 120) })
    expect(gated.hasLiveActivity()).toBe(false)
    expect(agent.status).toBe('idle')
  })
})
