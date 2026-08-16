/** ApiProxy /api fallback worker-forwarder routing tests (api-proxy ④). */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createApiProxyWorkerForwarder } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (value: string): SessionId => value as SessionId

/** Minimal control surface the forwarder touches. */
interface StubControl {
  get(id: SessionId): { readonly id: SessionId; readonly backend: 'local-ts' | 'worker-ts' } | undefined
  invokeApiProxy(id: SessionId, section: string, method: string, args: readonly unknown[]): Promise<unknown>
}

function request(method: string, payload: unknown, httpMethod = 'POST'): Request {
  return new Request(`http://host/api/${method}`, {
    method: httpMethod,
    headers: { 'content-type': 'application/json' },
    ...httpMethod === 'POST'
      ? { body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }) }
      : {},
  })
}

function forwarderContext(control: StubControl | undefined): Context {
  const ctx = new Context()
  if (control !== undefined) ctx.provide('agentControl', control as never)
  return ctx
}

describe('createApiProxyWorkerForwarder', () => {
  it('forwards a session method held on worker-ts with the narrow request envelope', async () => {
    const calls: Array<{ id: SessionId; section: string; method: string; args: readonly unknown[] }> = []
    const control: StubControl = {
      get: id => id === sid('s1') ? { id, backend: 'worker-ts' } : undefined,
      invokeApiProxy: async (id, section, method, args) => {
        calls.push({ id, section, method, args })
        return { rpcId: 'r1', result: { ok: true, value: { messages: [] } } }
      },
    }
    const hook = createApiProxyWorkerForwarder(forwarderContext(control))
    const response = await hook.tryForward(request('session.history', { sessionId: 's1', maxMessages: 5 }))
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      type: 'server-response',
      rpcId: 'r1',
      result: { ok: true, value: { messages: [] } },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.id).toBe(sid('s1'))
    expect(calls[0]?.section).toBe('session')
    expect(calls[0]?.method).toBe('session.history')
    // The api-proxy method receives the narrow { rpcId, payload } request.
    expect(calls[0]?.args).toEqual([{ rpcId: 'r1', payload: { sessionId: 's1', maxMessages: 5 } }])
  })

  it('forwards a subagent method via parentSessionId', async () => {
    const calls: string[] = []
    const control: StubControl = {
      get: id => id === sid('parent-1') ? { id, backend: 'worker-ts' } : undefined,
      invokeApiProxy: async (id, section, method) => {
        calls.push(`${id as string}:${section}:${method}`)
        return { rpcId: 'r1', result: { ok: true, value: [] } }
      },
    }
    const hook = createApiProxyWorkerForwarder(forwarderContext(control))
    const response = await hook.tryForward(request('subagent.list', { parentSessionId: 'parent-1' }))
    expect(response?.status).toBe(200)
    expect(calls).toEqual(['parent-1:subagent:subagent.list'])
  })

  it('leaves host-level methods to local dispatch', async () => {
    const control: StubControl = {
      get: () => ({ id: sid('s1'), backend: 'worker-ts' }),
      invokeApiProxy: async () => { throw new Error('must not forward') },
    }
    const hook = createApiProxyWorkerForwarder(forwarderContext(control))
    const response = await hook.tryForward(request('host.describe', {}))
    expect(response).toBeUndefined()
  })

  it('leaves local-ts and unheld generations to local dispatch', async () => {
    const control: StubControl = {
      get: () => ({ id: sid('s1'), backend: 'local-ts' }),
      invokeApiProxy: async () => { throw new Error('must not forward') },
    }
    const hook = createApiProxyWorkerForwarder(forwarderContext(control))
    expect(await hook.tryForward(request('session.history', { sessionId: 's1' }))).toBeUndefined()

    const unheld: StubControl = {
      get: () => undefined,
      invokeApiProxy: async () => { throw new Error('must not forward') },
    }
    const hook2 = createApiProxyWorkerForwarder(forwarderContext(unheld))
    expect(await hook2.tryForward(request('session.history', { sessionId: 's1' }))).toBeUndefined()
  })

  it('never forwards without a control provider, a POST body, or a valid envelope', async () => {
    const hook = createApiProxyWorkerForwarder(forwarderContext(undefined))
    expect(await hook.tryForward(request('session.history', { sessionId: 's1' }))).toBeUndefined()

    const control: StubControl = {
      get: () => ({ id: sid('s1'), backend: 'worker-ts' }),
      invokeApiProxy: async () => { throw new Error('must not forward') },
    }
    const hooked = createApiProxyWorkerForwarder(forwarderContext(control))
    expect(await hooked.tryForward(request('session.history', {}, 'GET'))).toBeUndefined()
    expect(await hooked.tryForward(new Request('http://host/api/session.history', {
      method: 'POST',
      body: 'not json',
    }))).toBeUndefined()
    expect(await hooked.tryForward(new Request('http://host/api/session.history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 1 }),
    }))).toBeUndefined()
  })
})
