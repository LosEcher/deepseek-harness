/**
 * Optional pre-dispatch Host forwarder for the /api fallback: routes
 * agent-scoped ApiProxy requests into the Agent worker that holds the
 * generation (api-proxy ④). Mirrors the Typert dispatch hook, but for the
 * unclaimed /api endpoints served by the api-proxy fetch handler. Opt-in:
 * the Connection /api fallback consults `ctx.apiProxyDispatchHook` when a
 * composition provides it.
 * @module @deepseek-ai/dsh-host-apiproxy
 */

import type { Context } from '@deepseek-ai/cordis'
import type AgentControl from '@deepseek-ai/dsh-agent-control'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { clientRequestSchema } from './api/index.ts'
import type { RpcResponse } from './api/rpc.ts'

/**
 * Optional pre-dispatch hook consulted by the Connection /api fallback
 * before it hands the request to the local api-proxy fetch handler.
 */
export interface ApiProxyDispatchHook {
  /**
   * Attempt to forward one request.
   * @param request - the HTTP request (the hook owns cloning before reading
   *   the body — the fallback re-reads it for local dispatch on `undefined`).
   * @returns the forwarded response, or `undefined` to dispatch locally.
   */
  tryForward(request: Request): Promise<Response | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional pre-dispatch forwarder for unclaimed /api endpoints. */
    apiProxyDispatchHook?: ApiProxyDispatchHook
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Create the worker-forwarding hook for the /api fallback. The control
 * provider is resolved per call, so composition order is irrelevant. Only
 * requests whose payload names a session identity (sessionId or
 * parentSessionId) held on worker-ts are forwarded; everything else
 * dispatches locally in the main process.
 * @param ctx - owning Host Context (Agent control optional).
 * @returns the hook, or one that never forwards when no control provider is
 *   mounted.
 */
export function createApiProxyWorkerForwarder(ctx: Context): ApiProxyDispatchHook {
  return {
    async tryForward(request: Request): Promise<Response | undefined> {
      const control: AgentControl | undefined = ctx.get('agentControl')
      if (control === undefined || request.method !== 'POST') return undefined
      let body: unknown
      try {
        body = await request.clone().json()
      } catch {
        return undefined
      }
      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) return undefined
      const { rpcId, method, payload } = envelope.data
      const identity = isRecord(payload)
        ? (typeof payload.sessionId === 'string'
          ? payload.sessionId
          : typeof payload.parentSessionId === 'string'
            ? payload.parentSessionId
            : undefined)
        : undefined
      if (identity === undefined) return undefined
      const held = control.get(identity as SessionId)
      if (held === undefined || held.backend !== 'worker-ts') return undefined
      const section = method.split('.')[0]
      if (section === undefined || section === '') return undefined
      // Mirror handleUnary: the api-proxy method receives the narrow
      // { rpcId, payload } request, and the response rides the full
      // server-response envelope.
      const response = await control.invokeApiProxy(held.id, section, method, [{ rpcId, payload }]) as RpcResponse<unknown>
      return Response.json({ type: 'server-response', rpcId: response.rpcId, result: response.result })
    },
  }
}
