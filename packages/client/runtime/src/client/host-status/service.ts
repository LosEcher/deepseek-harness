/**
 * HostStatusRuntime: the client's window into host lifecycle state that has
 * no session routing — today, the coordinated-restart window. The host
 * restart coordinator writes `$DSH_HOME/restart-pending` while a restart is
 * armed (and removes it before exit); `host.describe` carries it. The client
 * polls describe at a modest cadence so the shell can surface a "restarting"
 * banner instead of guessing from the connection dropping (which also covers
 * crashes — this source is explicitly about PLANned restarts).
 *
 * Polling is a deliberate trade: the restart window is seconds-long and the
 * poll is one cheap unary call; an event-stream frame would need a new
 * HostFrame type plus coordinator wiring for the same visibility. The store
 * exposes a plain snapshot so the UI reads it like any other client state.
 * @module dsh-client-runtime/host-status
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '../contract/store.ts'

/** Coordinated-restart window as reported by the host. */
export interface RestartPendingView {
  /** Host clock time (Date.now()) when the restart request was consumed. */
  sinceMs: number
  /** Coordinator wait cap for in-flight write tools before draining. */
  capMs: number
}

/** Trace of a completed coordinated restart, surfaced once after reconnection. */
export interface RestartExitedView {
  /** Host clock time when the coordinator drained and exited. */
  exitedAt: number
}

/** Immutable host-status projection consumed by the shell. */
export interface HostStatusState {
  /** Present while the host has armed a coordinated restart. */
  restartPending: RestartPendingView | undefined
  /**
   * Present when the host booted after a coordinated restart (the
   * coordinator's exit trace). The shell shows a one-shot "restart
   * completed" notice while it is fresh.
   */
  restartExited: RestartExitedView | undefined
  /** Whether the last describe poll succeeded (false while disconnected). */
  reachable: boolean
}

const INITIAL: HostStatusState = {
  restartPending: undefined,
  restartExited: undefined,
  reachable: false,
}

/** Poll cadence for the restart window (the window is seconds-long). */
export const HOST_STATUS_POLL_MS = 2_000

/**
 * Host-lifecycle state service: polls `host.describe` and projects the
 * coordinated-restart window into a snapshot store. Lifecycle: `start()` on
 * connection reset (the reconnect loop re-invokes it), `stop()` on teardown.
 */
export class HostStatusRuntime {
  /** UI-facing immutable projection. */
  readonly status: ReturnType<typeof createSnapshotStore<HostStatusState>>
  /** Poll timer, alive only between start() and stop(). */
  private timer: ReturnType<typeof setInterval> | undefined
  /** In-flight describe guard: polls never overlap (a slow unary just skips). */
  private polling = false
  /** Dropped by stop(); guards the async poll settle against teardown. */
  private stopped = true

  /**
   * @param ctx - client root context (for `ctx.reflect.provide`).
   * @param api - shared wire client.
   */
  constructor(ctx: Context, private readonly api: IApiClient) {
    this.status = createSnapshotStore<HostStatusState>(INITIAL)
    ctx.reflect.provide('hostStatus', this, undefined)
  }

  /** Begin (or resume) polling; idempotent. */
  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    void this.poll()
    this.timer = setInterval(() => { void this.poll() }, HOST_STATUS_POLL_MS)
    // A hidden tab does not need the restart window: pause polling while the
    // document is invisible and resume (with an immediate poll) on return.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }
  }

  /** Stop polling and reset to the disconnected projection. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
    }
    this.status.set({ restartPending: undefined, restartExited: undefined, reachable: false })
  }

  /** Pause on hide; resume with an immediate poll on show. */
  private onVisibilityChange = (): void => {
    if (this.stopped) return
    if (document.visibilityState === 'hidden') {
      if (this.timer !== undefined) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    } else if (this.timer === undefined) {
      void this.poll()
      this.timer = setInterval(() => { void this.poll() }, HOST_STATUS_POLL_MS)
    }
  }

  /** One describe round-trip; failures project unreachable without throwing. */
  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      const response = await this.api.host.describe({})
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() can run during the await.
      if (this.stopped) return
      if (!response.result.ok) {
        this.status.set({ restartPending: undefined, restartExited: undefined, reachable: false })
        return
      }
      this.status.set({
        restartPending: response.result.value.restartPending,
        restartExited: response.result.value.restartExited,
        reachable: true,
      })
    } catch {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() can run during the await.
      if (!this.stopped) this.status.set({ restartPending: undefined, restartExited: undefined, reachable: false })
    } finally {
      this.polling = false
    }
  }

  /**
   * Ask the host to drain immediately (O7): skips the coordinated-restart
   * wait by writing the `restart-immediate` signal. Returns whether the
   * signal was delivered. The banner's "restart now" button calls this.
   */
  async requestRestartImmediate(): Promise<boolean> {
    const response = await this.api.host.requestRestartImmediate({})
    return response.result.ok
  }
}
