/**
 * Coordinated-restart banner: the shell.overlay entry that surfaces the host's
 * armed restart window (HostStatusRuntime) as a compact top-of-screen notice.
 * Click-through like every overlay occupant, so it never blocks the app — the
 * restart is draining, not waiting on the user.
 * @module dsh-client-ui-restart-banner
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { HostStatusRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RestartBanner.module.css'

/** Injected face: the host-status service whose snapshot drives the banner. */
export interface RestartBannerInjected {
  /** HostStatusRuntime backing the `useHostStatus` snapshot (provided by the runtime). */
  hostStatus: HostStatusRuntime
}

/** Full banner props: injected face + the locale seat. */
export type RestartBannerProps = RestartBannerInjected & PropsLocale<'restartBanner'>

/**
 * Render the coordinated-restart banner while the host has armed a restart;
 * null otherwise. The remaining wait is derived from the armed window's cap,
 * so the copy is honest about the upper bound without needing a countdown;
 * the elapsed wait is ticked once per second so the notice stays informative
 * while the host drains.
 * @param props - injected host-status face; `t` rides the standard locale seat.
 * @returns the banner, or null when no restart is pending.
 */
export function RestartBanner({ hostStatus, t }: RestartBannerProps) {
  const { restartPending } = useSyncExternalStore(
    fn => hostStatus.status.subscribe(fn),
    () => hostStatus.status.getSnapshot(),
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (restartPending === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [restartPending === undefined])
  if (restartPending === undefined) return null
  const capSeconds = Math.max(1, Math.round(restartPending.capMs / 1000))
  const elapsedSeconds = Math.max(0, Math.round((now - restartPending.sinceMs) / 1000))
  return (
    <div className={css.banner} role="status" aria-label={t('banner.aria')}>
      <span className={css.title}>{t('banner.title')}</span>
      <span className={css.body}>{t('banner.body', { capSeconds, elapsedSeconds })}</span>
    </div>
  )
}
