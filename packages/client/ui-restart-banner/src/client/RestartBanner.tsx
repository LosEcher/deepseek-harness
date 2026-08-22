/**
 * Coordinated-restart banner: the shell.overlay entry that surfaces the host's
 * armed restart window (HostStatusRuntime) as a compact top-of-screen notice,
 * plus a one-shot "restart completed" notice after the host comes back and a
 * "restart now" button that skips the wait (O7). Click-through like every
 * overlay occupant except the button itself — the restart is draining, not
 * waiting on the user, but the user may always choose to skip the wait.
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

/** How long a completed-restart trace stays visible after reconnection. */
export const RESTART_EXITED_VISIBLE_MS = 60_000

/**
 * Render the coordinated-restart banner while the host has armed a restart,
 * and a one-shot "restart completed" notice while a fresh exit trace is
 * present; null otherwise. The remaining wait is derived from the armed
 * window's cap, so the copy is honest about the upper bound without needing a
 * countdown; the elapsed wait is ticked once per second so the notice stays
 * informative while the host drains.
 * @param props - injected host-status face; `t` rides the standard locale seat.
 * @returns the banner/notice, or null when nothing is pending.
 */
export function RestartBanner({ hostStatus, t }: RestartBannerProps) {
  const { restartPending, restartExited } = useSyncExternalStore(
    fn => hostStatus.status.subscribe(fn),
    () => hostStatus.status.getSnapshot(),
  )
  const [now, setNow] = useState(() => Date.now())
  const [restartRequested, setRestartRequested] = useState(false)
  // The completed-restart notice is one-shot per trace: dismissed by time or
  // by a newer trace arriving.
  const [dismissedExitedAt, setDismissedExitedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (restartPending === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [restartPending === undefined])
  const showExited = restartExited !== undefined
    && restartExited.exitedAt !== dismissedExitedAt
    && Date.now() - restartExited.exitedAt < RESTART_EXITED_VISIBLE_MS
  useEffect(() => {
    if (!showExited) return
    const timer = setTimeout(() => { setDismissedExitedAt(restartExited?.exitedAt) }, RESTART_EXITED_VISIBLE_MS)
    return () => { clearTimeout(timer) }
  }, [showExited])
  if (restartPending !== undefined) {
    const capSeconds = Math.max(1, Math.round(restartPending.capMs / 1000))
    const elapsedSeconds = Math.max(0, Math.round((now - restartPending.sinceMs) / 1000))
    return (
      <div className={css.banner} role="status" aria-label={t('banner.aria')}>
        <span className={css.title}>{t('banner.title')}</span>
        <span className={css.body}>{t('banner.body', { capSeconds, elapsedSeconds })}</span>
        <button
          type="button"
          className={css.action}
          disabled={restartRequested}
          onClick={() => {
            setRestartRequested(true)
            void hostStatus.requestRestartImmediate()
          }}
        >
          {restartRequested ? t('banner.restarting') : t('banner.restartNow')}
        </button>
      </div>
    )
  }
  if (showExited) {
    return (
      <div className={css.exited} role="status" aria-label={t('banner.exitedAria')}>
        <span className={css.title}>{t('banner.exitedTitle')}</span>
        <span className={css.body}>{t('banner.exitedBody')}</span>
      </div>
    )
  }
  return null
}
