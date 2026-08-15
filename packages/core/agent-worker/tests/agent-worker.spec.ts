import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentWorker, { WorkerSupervisor, type Config } from '@deepseek-ai/dsh-agent-worker'
import { lastOwnership } from '@deepseek-ai/dsh-agent-control'
import type { AgentControlMessage } from '@deepseek-ai/dsh-agent-control'
import { AgentControlError } from '@deepseek-ai/dsh-agent-control'

class FixtureAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function localTsConfig(overrides: Partial<Config> = {}): Config {
  return {
    backend: 'local-ts',
    commandQueueLimit: 32,
    eventCredit: 64,
    replayWindow: 1024,
    ...overrides,
  }
}

function asControl(message: ReturnType<typeof createUserMessage>): AgentControlMessage {
  return {
    id: message.id,
    role: 'user',
    content: message.content,
    source: message.source,
  }
}

async function localHarness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new FixtureAdapter())
  await ctx.plugin(AgentWorker, localTsConfig())
  return ctx
}

describe('local-ts', () => {
  it('creates a descriptor without exposing a live Agent', async () => {
    const ctx = await localHarness()
    const id = SessionId('local-create')
    const descriptor = await ctx.agentControl.create('host', {
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(descriptor.id).toBe(id)
    expect(descriptor.backend).toBe('local-ts')
    expect(descriptor.phase).toBe('ready')
    expect(ctx.agentControl.get(id)?.generation).toBe(descriptor.generation)
    expect(ctx.agentControl.list()).toHaveLength(1)
    expect(ctx.agentControl.isOwnedBy(id, 'host')).toBe(true)
    expect(ctx.agentControl.roots()).toHaveLength(1)
    const agent = ctx.agents.get(id)
    expect(agent).toBeDefined()
    if (agent === undefined) throw new Error('expected local-ts create to register a live Agent')
    expect(lastOwnership(agent.session.events)?.action).toBe('acquire')
  })

  it('drives followup and cancel through the control service', async () => {
    const ctx = await localHarness()
    const id = SessionId('local-followup')
    await ctx.agentControl.create('host', {
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ctx.agentControl.followup(id, asControl(createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })))
    await ctx.agentControl.whenIdle(id)
    expect(ctx.agentControl.get(id)?.status).toBe('idle')
    await ctx.agentControl.cancel(id, { kind: 'user' })
  })

  it('refuses a command after drain', async () => {
    const ctx = await localHarness()
    const id = SessionId('local-drain')
    await ctx.agentControl.create('host', {
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ctx.agentControl.drain(id)
    expect(ctx.agentControl.get(id)?.phase).toBe('drained')
    await expect(ctx.agentControl.followup(id, asControl(createUserMessage({
      content: [{ type: 'text', text: 'late' }],
      source: { kind: 'user' },
    })))).rejects.toBeInstanceOf(AgentControlError)
  })
})

describe('local-ts drain-and-resume', () => {
  it('releases the lease and resumes as a new generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-control-'))
    dirs.push(root)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    ctx.llm.registerAdapter(['mock'], new FixtureAdapter())
    await ctx.plugin(AgentWorker, localTsConfig({ sessionRoot: root }))
    const id = SessionId('local-resume')
    const first = await ctx.agentControl.create('host', {
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ctx.agentControl.drain(id)
    const second = await ctx.agentControl.resume('host', {
      resumeSessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(second.generation).toBeGreaterThan(first.generation)
    const resumed = ctx.agents.get(id)
    expect(resumed).toBeDefined()
    if (resumed === undefined) throw new Error('expected local-ts resume to register a live Agent')
    expect(lastOwnership(resumed.session.events)).toMatchObject({
      action: 'acquire',
      generation: second.generation,
    })
  })
})

describe('worker-ts', () => {
  it('creates an isolated worker and keeps a sibling alive after kill', async () => {
    const supervisor = new WorkerSupervisor({
      backend: 'worker-ts',
      commandQueueLimit: 32,
      eventCredit: 64,
      replayWindow: 1024,
    })
    const first = SessionId('worker-a')
    const second = SessionId('worker-b')
    const a = await supervisor.create('host', {
      sessionId: first,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const b = await supervisor.create('host', {
      sessionId: second,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(a.backend).toBe('worker-ts')
    expect(b.generation).not.toBe(a.generation)
    supervisor.kill(first)
    await vi.waitFor(() => { expect(supervisor.get(first)?.phase).toBe('faulted') })
    expect(supervisor.get(second)?.phase).toBe('ready')
    await supervisor.whenIdle(second)
    await supervisor.dispose(second)
    await supervisor.dispose(first)
  }, 30_000)

  it('drain-and-resume preserves one writer across processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-worker-'))
    dirs.push(root)
    const supervisor = new WorkerSupervisor({
      backend: 'worker-ts',
      commandQueueLimit: 32,
      eventCredit: 64,
      replayWindow: 1024,
      sessionRoot: root,
    })
    const id = SessionId('worker-resume')
    const first = await supervisor.create('host', {
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await supervisor.drain(id)
    const second = await supervisor.resume('host', {
      resumeSessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(second.generation).toBeGreaterThan(first.generation)
    await supervisor.dispose(id)
  }, 30_000)
})
