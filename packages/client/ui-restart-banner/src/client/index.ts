/**
 * Restart banner client plugin: self-registers the banner into
 * `shell.overlay` once the layout declarer is up, wiring HostStatusRuntime's
 * snapshot as the injected face. The banner renders only while the host has
 * armed a coordinated restart, so the shell never guesses from a dropped
 * connection.
 * @module dsh-client-ui-restart-banner
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostStatusRuntime } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the 'shell.overlay' SlotMap declaration (the layout plugin
// declares the seat; this entry is a fresh additive id beside shipped ones).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { RestartBanner, type RestartBannerInjected } from './RestartBanner.tsx'
import { en, zh, type RestartBannerKey } from './locales.ts'

export { RestartBanner } from './RestartBanner.tsx'
export type { RestartBannerInjected, RestartBannerProps } from './RestartBanner.tsx'
export type { RestartBannerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The coordinated-restart banner's copy. */
    restartBanner: RestartBannerKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'restartBanner'

/** Required services: the locale registry, slot registry, and host-status service. */
export const inject = ['locale', 'slots', 'hostStatus']

/**
 * Client plugin body: register the dictionaries, then mount the banner into
 * the shell overlay once its declarer is up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-restart-banner: dictionaries')
  ctx.inject(['slots', 'hostStatus'], (scope: ClientContext) => {
    const hostStatus = scope.get('hostStatus') as HostStatusRuntime
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay',
      id: 'restart-banner',
      order: 10,
      locale: NS,
      inject: (): RestartBannerInjected => ({ hostStatus }),
    }, RestartBanner))
  })
}
