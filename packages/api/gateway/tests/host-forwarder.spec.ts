/** Host worker forwarder routing tests (api-proxy ④b). */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createHostWorkerForwarder } from '@deepseek-ai/dsh-api-gateway'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

const sid = (value: string): SessionId => value as SessionId

/** Minimal control surface the forwarder touches. */
interface StubControl {
  get(id: SessionId): { readonly id: SessionId; readonly backend: 'local-ts' | 'worker-ts' } | undefined
  invokeHost(id: SessionId, namespace: string, method: string, args: Record<string, unknown>): Promise<unknown>
}

function scopeDescriptor(wire: string): InvocationDescriptor {
  return {
    id: 'fixture#scope',
    service: 'fixture',
    namespace: 'fixture',
    method: 'run',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire },
    parameters: [],
    result: { mode: 'strict', typeSymbol: 'fixture#Result', schema: { parse: (value: unknown) => value } },
  }
}

function contextDescriptor(wire: string): InvocationDescriptor {
  return {
    id: 'fixture#context',
    service: 'fixture',
    namespace: 'fixture',
    method: 'run',
    invocation: { kind: 'context', context: 'agent', wire, codec: { mode: 'strict', typeSymbol: 'fixture#Id', schema: { parse: (value: unknown) => String(value) } } },
    parameters: [],
    result: { mode: 'strict', typeSymbol: 'fixture#Result', schema: { parse: (value: unknown) => value } },
  }
}

function directDescriptor(): InvocationDescriptor {
  return {
    id: 'fixture#direct',
    service: 'fixture',
    namespace: 'fixture',
    method: 'run',
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'strict', typeSymbol: 'fixture#Result', schema: { parse: (value: unknown) => value } },
  }
}

function forwarderContext(control: StubControl | undefined): Context {
  const ctx = new Context()
  if (control !== undefined) ctx.provide('agentControl', control as never)
  return ctx
}

describe('createHostWorkerForwarder', () => {
  it('forwards a scope-agent invocation held on worker-ts', async () => {
    const calls: Array<{ id: SessionId; namespace: string; method: string; args: Record<string, unknown> }> = []
    const control: StubControl = {
      get: id => id === sid('session-1') ? { id, backend: 'worker-ts' } : undefined,
      invokeHost: async (id, namespace, method, args) => {
        calls.push({ id, namespace, method, args })
        return { ok: true }
      },
    }
    const hook = createHostWorkerForwarder(forwarderContext(control))
    const result = await hook.tryForward(
      { namespace: 'fixture', method: 'run', args: { agentId: 'session-1' } },
      scopeDescriptor('agentId'),
    )
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{
      id: sid('session-1'),
      namespace: 'fixture',
      method: 'run',
      args: { agentId: 'session-1' },
    }])
  })

  it('forwards a context-agent invocation held on worker-ts', async () => {
    const calls: string[] = []
    const control: StubControl = {
      get: id => id === sid('session-2') ? { id, backend: 'worker-ts' } : undefined,
      invokeHost: async (id, _namespace, _method, _args) => {
        calls.push(id as string)
        return 'forwarded'
      },
    }
    const hook = createHostWorkerForwarder(forwarderContext(control))
    const result = await hook.tryForward(
      { namespace: 'fixture', method: 'run', args: { sessionId: 'session-2' } },
      contextDescriptor('sessionId'),
    )
    expect(result).toBe('forwarded')
    expect(calls).toEqual(['session-2'])
  })

  it('leaves direct invocations to local dispatch', async () => {
    const control: StubControl = {
      get: () => ({ id: sid('session-1'), backend: 'worker-ts' }),
      invokeHost: async () => { throw new Error('must not forward') },
    }
    const hook = createHostWorkerForwarder(forwarderContext(control))
    const result = await hook.tryForward(
      { namespace: 'fixture', method: 'run', args: {} },
      directDescriptor(),
    )
    expect(result).toBeUndefined()
  })

  it('leaves local-ts generations to local dispatch', async () => {
    const control: StubControl = {
      get: id => id === sid('session-1') ? { id, backend: 'local-ts' } : undefined,
      invokeHost: async () => { throw new Error('must not forward') },
    }
    const hook = createHostWorkerForwarder(forwarderContext(control))
    const result = await hook.tryForward(
      { namespace: 'fixture', method: 'run', args: { agentId: 'session-1' } },
      scopeDescriptor('agentId'),
    )
    expect(result).toBeUndefined()
  })

  it('leaves unheld generations to local dispatch', async () => {
    const control: StubControl = {
      get: () => undefined,
      invokeHost: async () => { throw new Error('must not forward') },
    }
    const hook = createHostWorkerForwarder(forwarderContext(control))
    const result = await hook.tryForward(
      { namespace: 'fixture', method: 'run', args: { agentId: 'session-1' } },
      scopeDescriptor('agentId'),
    )
    expect(result).toBeUndefined()
  })

  it('never forwards without a control provider', async () => {
    const hook = createHostWorkerForwarder(forwarderContext(undefined))
    const result = await hook.tryForward(
      { namespace: 'fixture', method: 'run', args: { agentId: 'session-1' } },
      scopeDescriptor('agentId'),
    )
    expect(result).toBeUndefined()
  })
})
