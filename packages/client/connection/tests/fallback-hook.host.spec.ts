/** Connection /api fallback dispatch-hook consultation (api-proxy ④). */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection'
import type { ApiProxyDispatchHook } from '@deepseek-ai/dsh-host-apiproxy'

function fakeHttpServer(routes: WebRoute[]): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade: () => () => {},
    tapIndex: () => () => {},
    port: 0,
  }
}

async function serveRoute(route: WebRoute): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void route.handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
  }
}

async function boot(hook: ApiProxyDispatchHook | undefined): Promise<{
  origin: string
  close(): Promise<void>
  localCalls(): number
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes) as never)
  // Minimal api-proxy: one session.history method the local fallback can serve.
  let localCalls = 0
  ctx.provide('apiProxy', {
    sessions: {
      history: async (request: { rpcId: string }) => {
        localCalls += 1
        return { rpcId: request.rpcId, result: { ok: true, value: { local: true } } }
      },
    },
  } as never)
  if (hook !== undefined) ctx.provide('apiProxyDispatchHook', hook)
  applyConnection(ctx)
  const route = routes.find(candidate => candidate.kind === 'prefix' && candidate.path === '/api')
  if (route === undefined) throw new Error('no /api route registered')
  const served = await serveRoute(route)
  return { origin: served.origin, close: served.close, localCalls: () => localCalls }
}

describe('Connection /api fallback dispatch hook', () => {
  it('serves the hook response and never touches the local api-proxy', async () => {
    const forwarded: string[] = []
    const harness = await boot({
      tryForward: async (request) => {
        forwarded.push(new URL(request.url).pathname)
        return Response.json({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { forwarded: true } } })
      },
    })
    try {
      const response = await fetch(`${harness.origin}/api/session.history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.history', payload: { sessionId: 's1' } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        type: 'server-response',
        rpcId: 'r1',
        result: { ok: true, value: { forwarded: true } },
      })
      expect(forwarded).toEqual(['/api/session.history'])
      expect(harness.localCalls()).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('falls through to the local api-proxy when the hook declines', async () => {
    const harness = await boot({ tryForward: async () => undefined })
    try {
      const response = await fetch(`${harness.origin}/api/session.history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.history', payload: { sessionId: 's1' } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ result: { ok: true, value: { local: true } } })
      expect(harness.localCalls()).toBe(1)
    } finally {
      await harness.close()
    }
  })
})
