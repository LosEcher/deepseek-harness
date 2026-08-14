import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Agent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

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
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    adapter.script.push(delayedTextResponse(60, 'done'))
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
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    adapter.script.push('hang')
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
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    adapter.script.push(delayedTextResponse(500, 'done-a'))
    adapter.script.push(delayedTextResponse(500, 'done-b'))
    const a = await ctx.agentLoop.create(SessionId('drain-all-a'), { provider: 'mock', model: 'mock' })
    const b = await ctx.agentLoop.create(SessionId('drain-all-b'), { provider: 'mock', model: 'mock' })
    const aRunning = waitForStatus(ctx, a, 'running')
    const bRunning = waitForStatus(ctx, b, 'running')
    send(a, 'hello a')
    send(b, 'hello b')
    await Promise.all([aRunning, bRunning])
    // Both turns sit in their model wait.
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))

    // Model waits have no side effects: both drain as 'pending' (safe). The
    // turn stays open for post-resume rebuild — or, if the model response
    // lands during teardown, it completes naturally (turn/end completed),
    // which is even better. Either way no interrupted synthesis applies.
    const ok = await ctx.agentLoop.shutdownDrain(5_000)
    expect(ok).toBe(true)
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
