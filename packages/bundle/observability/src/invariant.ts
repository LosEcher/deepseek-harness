/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-observability`.
 * @module @deepseek-ai/dsh-observability/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-observability'

/** Cordis companion plugin name. */
export const name = 'observability-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the metrics registry is a pure derived fold over the
 * session event stream with no mutable cross-session relation the audit tree
 * needs to hold (counters are process-scoped projections, rebuilt from events
 * on restart by design). It registers nothing.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
