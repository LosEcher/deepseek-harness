/**
 * Restart-banner plugin, node half. The empty apply mounts this pure UI plugin
 * in the host tree; the browser implementation ships through ./client.
 * @module @deepseek-ai/dsh-client-ui-restart-banner
 */

export type { RestartBannerInjected, RestartBannerProps } from './client/RestartBanner.tsx'
export type { RestartBannerKey } from './client/locales.ts'

/** Host plugin body; this surface has no host-side behavior. */
export function apply(): void {}
