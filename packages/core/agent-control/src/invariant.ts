/** Package-owned session-ownership invariants. @module @deepseek-ai/dsh-agent-control/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionOwnership } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-control'

/** Cordis companion plugin name. */
export const name = 'agent-control-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface OwnershipTrace {
  holder: SessionOwnership | undefined
}

/** Require a durable ownership record to name a positive generation. */
function validateOwnership(data: SessionOwnership, fail: InvariantFailure): void {
  if (!Number.isInteger(data.generation) || data.generation <= 0) {
    fail('session/ownership generation must be a positive integer')
  }
  if (data.action !== 'acquire' && data.action !== 'release') {
    fail(`session/ownership action ${String(data.action)} is not acquire or release`)
  }
  if (data.backend !== 'local-ts' && data.backend !== 'worker-ts') {
    fail(`session/ownership backend ${String(data.backend)} is not local-ts or worker-ts`)
  }
  if (typeof data.owner !== 'string' || data.owner.length === 0) {
    fail('session/ownership owner must be a non-empty string')
  }
}

/** Install ownership acquire/release checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, OwnershipTrace>()
  const staged = new WeakMap<SessionEvent, SessionOwnership>()
  const seed = (session: Session): OwnershipTrace => {
    const trace: OwnershipTrace = { holder: undefined }
    traces.set(session, trace)
    for (const event of session.events) {
      if (event.type === 'session/ownership') {
        validateTransition(trace, event.data, fail)
        trace.holder = event.data
      }
    }
    return trace
  }
  const traceFor = (session: Session): OwnershipTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'session/ownership') return
    validateTransition(traceFor(session), event.data, fail)
    staged.set(event, event.data)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'session/ownership') return
    const next = staged.get(event)
    /* v8 ignore next -- internal/dispatch stages every ownership event */
    if (next === undefined) return fail('session/ownership published without pre-commit validation')
    staged.delete(event)
    traceFor(session).holder = next
  }, { global: true })
}, { inject: ['sessions'] })

function validateTransition(trace: OwnershipTrace, data: SessionOwnership, fail: InvariantFailure): void {
  validateOwnership(data, fail)
  if (data.action === 'acquire') {
    if (trace.holder !== undefined && trace.holder.action === 'acquire' && trace.holder.generation !== data.generation) {
      fail(`session/ownership acquire generation ${data.generation} while generation ${trace.holder.generation} still holds`)
    }
    return
  }
  if (trace.holder === undefined || trace.holder.action !== 'acquire') {
    fail('session/ownership release has no matching acquire')
  } else if (trace.holder.generation !== data.generation) {
    fail(`session/ownership release generation ${data.generation} does not match holder ${trace.holder.generation}`)
  }
}

/**
 * Register the agent-control invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
