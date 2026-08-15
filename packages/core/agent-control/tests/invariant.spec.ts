import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as AgentControlInvariant from '@deepseek-ai/dsh-agent-control/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentControlInvariant)
  return ctx
}

describe('agent-control invariants', () => {
  it('accepts acquire then release for one generation', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('own-ok'))
    session.append('session/ownership', {
      generation: 1,
      action: 'acquire',
      backend: 'worker-ts',
      owner: 'host',
    })
    session.append('session/ownership', {
      generation: 1,
      action: 'release',
      backend: 'worker-ts',
      owner: 'host',
    })
    expect(session.events).toHaveLength(2)
  })

  it('rejects a second acquire while another generation holds', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('own-held'))
    session.append('session/ownership', {
      generation: 1,
      action: 'acquire',
      backend: 'local-ts',
      owner: 'host',
    })
    expect(() => session.append('session/ownership', {
      generation: 2,
      action: 'acquire',
      backend: 'local-ts',
      owner: 'host',
    })).toThrow(/still holds/)
  })

  it('rejects a release without a matching acquire', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('own-release'))
    expect(() => session.append('session/ownership', {
      generation: 1,
      action: 'release',
      backend: 'local-ts',
      owner: 'host',
    })).toThrow(/no matching acquire/)
  })
})
