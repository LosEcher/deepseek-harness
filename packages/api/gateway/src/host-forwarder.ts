/**
 * Optional pre-dispatch Host forwarder: routes agent-scoped Typert
 * invocations into the Agent worker that holds the generation (api-proxy
 * ④b). When the composed Agent control provider holds the session on
 * `worker-ts`, the invocation executes inside that worker's own Gateway
 * (the `host` service on the product bridge), whose descriptor catalog and
 * lookups run against the worker-local live world; anything else dispatches
 * locally in the main process. Opt-in: the Gateway consults
 * `ctx.typertDispatchHook` when a composition provides it.
 * @module @deepseek-ai/dsh-api-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type AgentControl from '@deepseek-ai/dsh-agent-control'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import type { InvokeRemoteRequest, TypertDispatchHook } from './types.ts'

/** The wire field carrying the agent identity for one descriptor, when agent-scoped. */
function agentScopeWire(descriptor: InvocationDescriptor): string | undefined {
  if (descriptor.scope !== undefined && descriptor.scope.context === 'agent') return descriptor.scope.wire
  if (descriptor.invocation.kind === 'context' && descriptor.invocation.context === 'agent') {
    return descriptor.invocation.wire
  }
  return undefined
}

/**
 * Create the worker-forwarding dispatch hook for one Host context. The
 * control provider is resolved per call, so composition order is irrelevant
 * (the hook may be provided before or after the control row mounts).
 * @param ctx - owning Host Context (Agent control optional).
 * @returns the hook, or one that never forwards when no control provider is
 *   mounted (the Gateway then dispatches everything locally).
 */
export function createHostWorkerForwarder(ctx: Context): TypertDispatchHook {
  return {
    async tryForward(request: InvokeRemoteRequest, descriptor: InvocationDescriptor): Promise<unknown> {
      const control: AgentControl | undefined = ctx.get('agentControl')
      if (control === undefined) return undefined
      const wire = agentScopeWire(descriptor)
      if (wire === undefined) return undefined
      const identity = request.args[wire]
      if (typeof identity !== 'string') return undefined
      const held = control.get(identity as SessionId)
      if (held === undefined || held.backend !== 'worker-ts') return undefined
      return control.invokeHost(held.id, request.namespace, request.method, { ...request.args })
    },
  }
}
