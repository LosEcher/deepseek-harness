/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-worker`.
 * @module @deepseek-ai/dsh-agent-worker/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-worker'

/** Cordis companion plugin name. */
export const name = 'agent-worker-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: process-exit and generation retirement are asserted by
 * supervisor tests against the worker's observed generation, not a same-process
 * event stream. Ownership events are checked by `@deepseek-ai/dsh-agent-control`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
