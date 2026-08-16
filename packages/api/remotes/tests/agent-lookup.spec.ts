import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentControl from '@deepseek-ai/dsh-agent-control'
import type {
  AgentControlCreateOptions,
  AgentControlMessage,
  AgentControlNotification,
  AgentControlResumeOptions,
  AgentDescriptor,
} from '@deepseek-ai/dsh-agent-control'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { ApiRemoteSessionNotFound, createApiRemoteAgentProjection, createApiRemoteAgentResolver } from '@deepseek-ai/dsh-api-remotes'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const sid = (value: string): SessionId => value as SessionId

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/proj' }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function provideSession(
  ctx: Context,
  meta: SessionHeader,
  inspect: () => Promise<{ meta: SessionHeader; events: SessionEvent[] }>,
): void {
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect,
    locate: () => undefined,
  } as never)
}

function stubAgent(ctx: Context, session: Session): Agent {
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

describe('API Remote Agent resolver races', () => {
  it('maps an inspected session without a cwd to session-not-found', async () => {
    const ctx = await createContext()
    const sessionId = sid('missing-after-inspect')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => Promise.resolve({
      meta: { ...meta, cwd: undefined } as unknown as SessionHeader,
      events: [],
    }))

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'session-not-found', details: { sessionId } } })
    await ctx.fiber.dispose()
  })

  it('resumes through a concurrently attached ordinary Session without optional defaults', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-attach-race')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects a subagent Session published after durable inspection', async () => {
    const ctx = await createContext()
    const sessionId = sid('owned-attach-race')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => {
      ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reclassifies failed resumes after a live or attached subagent wins publication', async () => {
    for (const winner of ['agent', 'session'] as const) {
      const ctx = await createContext()
      const sessionId = sid(`owned-${winner}-resume-race`)
      const meta = header(sessionId)
      provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
      vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
        if (winner === 'agent') ctx.agents.register(stubAgent(ctx, session))
        throw new Error('session id already published')
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ error: { code: 'agent-busy' } })
      await ctx.fiber.dispose()
    }
  })

  it('uses the shared cold-resume policy for the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-cold-resume')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const agentCtx = ctx.extend()
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(agentCtx, published), dispose: () => Promise.resolve() }
    })
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    await expect(provider.resolve(sessionId)).resolves.toBe(agentCtx)
    await ctx.fiber.dispose()
  })

  it('applies the subagent ownership fence to the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-owned-subagent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    ctx.agents.register(stubAgent(ctx.extend(), session))
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    const resolution = provider.resolve(sessionId)
    await expect(resolution).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(resolution).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
    await ctx.fiber.dispose()
  })
})

/** Minimal control provider recording commands and holding descriptors. */
class StubControl extends AgentControl {
  readonly calls: string[] = []
  readonly held = new Map<SessionId, AgentDescriptor>()

  override async create(_owner: string, options: AgentControlCreateOptions): Promise<AgentDescriptor> {
    this.calls.push('create')
    const descriptor = descriptorFor(options.sessionId)
    this.held.set(options.sessionId, descriptor)
    return descriptor
  }

  override async resume(_owner: string, options: AgentControlResumeOptions): Promise<AgentDescriptor> {
    this.calls.push('resume')
    const descriptor = descriptorFor(options.resumeSessionId)
    this.held.set(options.resumeSessionId, descriptor)
    return descriptor
  }

  override async send(_id: SessionId, _message: AgentControlMessage, _target: 'next-turn' | 'next-step', _wakeup: boolean): Promise<void> {
    this.calls.push('send')
  }

  override async followup(_id: SessionId, _message: AgentControlMessage): Promise<void> {
    this.calls.push('followup')
  }

  override async steer(_id: SessionId, _message: AgentControlMessage): Promise<void> {
    this.calls.push('steer')
  }

  override async inject(_id: SessionId, _message: AgentControlMessage): Promise<void> {
    this.calls.push('inject')
  }

  override async cancel(_id: SessionId, _cause: { readonly kind: string; readonly reason?: string }, _keepInbox?: boolean): Promise<void> {
    this.calls.push('cancel')
  }

  override async whenIdle(_id: SessionId): Promise<void> {
    this.calls.push('whenIdle')
  }

  override async flush(_id: SessionId): Promise<void> {
    this.calls.push('flush')
  }

  override async drain(_id: SessionId): Promise<void> {
    this.calls.push('drain')
  }

  override async dispose(_id: SessionId): Promise<void> {
    this.calls.push('dispose')
  }

  override get(id: SessionId): AgentDescriptor | undefined {
    return this.held.get(id)
  }

  override list(): AgentDescriptor[] {
    return [...this.held.values()]
  }

  override roots(): AgentDescriptor[] {
    return [...this.held.values()]
  }

  override isOwnedBy(id: SessionId, owner: string): boolean {
    return this.held.get(id)?.id === id && owner === 'host'
  }

  override onNotification(_listener: (notification: AgentControlNotification) => void): () => void {
    return () => {}
  }

  override async invokeHost(_id: SessionId, _namespace: string, _method: string, _args: Record<string, unknown>): Promise<unknown> {
    throw new Error('not used in projection tests')
  }

  override async invokeApiProxy(_id: SessionId, _section: string, _method: string, _args: readonly unknown[]): Promise<unknown> {
    throw new Error('not used in projection tests')
  }
}

function descriptorFor(id: SessionId): AgentDescriptor {
  return { id, generation: 1, backend: 'worker-ts', status: 'idle', phase: 'ready', configDigest: 'stub' }
}

describe('API Remote Agent projection factory', () => {
  async function projectionContext(held: readonly SessionId[] = []): Promise<{ ctx: Context; control: StubControl }> {
    const ctx = await createContext()
    await ctx.plugin(StubControl)
    const control = ctx.agentControl as unknown as StubControl
    for (const id of held) control.held.set(id, descriptorFor(id))
    return { ctx, control }
  }

  it('projects a durable cold session and resumes it through the control provider', async () => {
    const { ctx, control } = await projectionContext()
    const sessionId = sid('project-cold')
    provideSession(ctx, header(sessionId), () => Promise.resolve({ meta: header(sessionId), events: [] }))
    const result = await createApiRemoteAgentProjection(ctx)(sessionId)
    expect('projection' in result).toBe(true)
    if (!('projection' in result)) return
    expect(result.projection.header?.cwd).toBe('/proj')
    expect(result.projection.descriptor?.id).toBe(sessionId)
    expect(control.calls).toContain('resume')
    await result.projection.control!.whenIdle()
    expect(control.calls).toContain('whenIdle')
    await ctx.fiber.dispose()
  })

  it('reuses a held generation without resuming', async () => {
    const sessionId = sid('project-held')
    const { ctx, control } = await projectionContext([sessionId])
    provideSession(ctx, header(sessionId), () => Promise.resolve({ meta: header(sessionId), events: [] }))
    const result = await createApiRemoteAgentProjection(ctx)(sessionId)
    expect('projection' in result).toBe(true)
    if (!('projection' in result)) return
    expect(control.calls).not.toContain('resume')
    expect(result.projection.descriptor?.phase).toBe('ready')
    await ctx.fiber.dispose()
  })

  it('returns a pure cold read without a control provider', async () => {
    const ctx = await createContext()
    const sessionId = sid('project-no-control')
    provideSession(ctx, header(sessionId), () => Promise.resolve({ meta: header(sessionId), events: [] }))
    const result = await createApiRemoteAgentProjection(ctx)(sessionId)
    expect('projection' in result).toBe(true)
    if (!('projection' in result)) return
    expect(result.projection.id).toBe(sessionId)
    expect(result.projection.control).toBeUndefined()
    expect(result.projection.descriptor).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps the subagent fence on projected headers', async () => {
    const { ctx } = await projectionContext()
    const sessionId = sid('project-subagent')
    const meta = { ...header(sessionId), origin: 'subagent' as const }
    provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
    const result = await createApiRemoteAgentProjection(ctx)(sessionId)
    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    await ctx.fiber.dispose()
  })

  it('maps a missing durable session to session-not-found without a control provider', async () => {
    const ctx = await createContext()
    const sessionId = sid('project-missing')
    provideSession(ctx, header(sessionId), () => Promise.reject(new ApiRemoteSessionNotFound('not durable')))
    const result = await createApiRemoteAgentProjection(ctx)(sessionId)
    expect(result).toMatchObject({ error: { code: 'session-not-found', details: { sessionId } } })
    await ctx.fiber.dispose()
  })

  it('projects an in-flight first generation the durable store does not list', async () => {
    const sessionId = sid('project-inflight')
    const { ctx, control } = await projectionContext([sessionId])
    provideSession(ctx, header(sessionId), () => Promise.reject(new ApiRemoteSessionNotFound('not durable yet')))
    const result = await createApiRemoteAgentProjection(ctx)(sessionId)
    expect('projection' in result).toBe(true)
    if (!('projection' in result)) return
    expect(result.projection.descriptor?.id).toBe(sessionId)
    expect(control.calls).not.toContain('resume')
    await ctx.fiber.dispose()
  })
})
