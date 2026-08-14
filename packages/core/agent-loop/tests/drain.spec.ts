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
  drainToIdle(timeoutMs: number): Promise<boolean>
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

function lastTurnEndReason(agent: Agent): string | undefined {
  const end = agent.session.events.findLast(e => e.type === 'turn/end')
  return end?.type === 'turn/end' ? end.data.reason.kind : undefined
}

describe('agent drain to turn boundary', () => {
  it('lets the in-flight turn finish (model wait included) and closes the turn gate', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    adapter.script.push(delayedTextResponse(60, 'done'))
    const agent = await ctx.agentLoop.create(SessionId('drain-completes'), { provider: 'mock', model: 'mock' })
    const running = waitForStatus(ctx, agent, 'running')
    send(agent, 'hello')
    await running
    // Wait until the model request is actually in flight (step >= 1), which is
    // the drainable window: a drain at step 0 (pre-step) must not run work.
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // The turn is inside its model wait; drain must wait it out, not abort it.
    const idle = await (agent as unknown as Drainable).drainToIdle(5_000)
    expect(idle).toBe(true)
    expect(agent.status).toBe('idle')
    const endEvent = agent.session.events.findLast(e => e.type === 'turn/end')
    console.error('TURN END DETAIL:', JSON.stringify(endEvent?.data, null, 1))
    expect(lastTurnEndReason(agent)).toBe('completed')

    // The drain gate stays closed: waking input after draining must not open
    // a new turn; the message stays pending for post-resume handling.
    send(agent, 'after-drain')
    await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
    expect(agent.session.events.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(agent.status).toBe('idle')
  })

  it('times out on a hanging turn and leaves the abort path intact', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    adapter.script.push('hang')
    const agent = await ctx.agentLoop.create(SessionId('drain-timeout'), { provider: 'mock', model: 'mock' })
    const running = waitForStatus(ctx, agent, 'running')
    send(agent, 'hello')
    await running

    const idle = await (agent as unknown as Drainable).drainToIdle(100)
    expect(idle).toBe(false)
    // The hanging turn was NOT aborted by the drain: the caller's cancel path
    // still owns that decision.
    expect(agent.status).toBe('running')
  })

  it('shutdownDrain waits every live agent to a clean boundary before teardown', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    adapter.script.push(delayedTextResponse(40, 'done-a'))
    adapter.script.push(delayedTextResponse(40, 'done-b'))
    const a = await ctx.agentLoop.create(SessionId('drain-all-a'), { provider: 'mock', model: 'mock' })
    const b = await ctx.agentLoop.create(SessionId('drain-all-b'), { provider: 'mock', model: 'mock' })
    const aRunning = waitForStatus(ctx, a, 'running')
    const bRunning = waitForStatus(ctx, b, 'running')
    send(a, 'hello a')
    send(b, 'hello b')
    await Promise.all([aRunning, bRunning])
    // Both turns sit in their model wait.
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))

    const ok = await ctx.agentLoop.shutdownDrain(5_000)
    expect(ok).toBe(true)
    expect(lastTurnEndReason(a)).toBe('completed')
    expect(lastTurnEndReason(b)).toBe('completed')
    expect(a.status).toBe('idle')
    expect(b.status).toBe('idle')
  })
})
