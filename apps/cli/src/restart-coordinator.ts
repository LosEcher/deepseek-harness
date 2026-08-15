/**
 * dsh — restart coordinator.
 *
 * Turns an external `restart-request` file (touched by dsh-web-restart.sh, or
 * by the daemon on plugin-manifest / git-head reloads) into a *coordinated*
 * exit: the process waits for every live agent turn to settle at a natural
 * boundary, then exits 0 through the ordinary shutdown path. The supervisor
 * only waits (with a force-kill backstop), so a busy turn finishes instead of
 * being cut mid-execution — the restart point is the last active turn's
 * natural completion, not a supervisor timer. This is the "执行面自决退出"
 * design: the exit timing lives in the event-sourced execution surface, not
 * in the shell supervisor.
 *
 * Implementation notes:
 * - Process-level plain interval (not a cordis service): it must keep running
 *   while the tree is partially torn down and must not extend the shutdown
 *   force-exit budget.
 * - The agent loop is resolved lazily because it mounts during boot; one-shot
 *   surfaces without an agent loop exit immediately on request.
 * - Once armed, `markDraining()` refuses new turns (wake gate), so the wait
 *   converges: the in-flight turn finishes, the driver exits to idle.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Poll cadence for the request file and, once armed, for live activity. */
export const RESTART_POLL_MS = 1_000
/** Cap for waiting on live turns before falling back to the drain path. */
export const RESTART_WAIT_CAP_MS = 5 * 60_000

/** The agent-loop surface the coordinator needs (see AgentLoop). */
export interface RestartCoordinatorAgentLoop {
  markDraining(): void
  hasLiveActivity(): boolean
}

export interface RestartCoordinatorOptions {
  dshHome: string
  /** Lazily-resolved agent loop (mounted during boot; absent on one-shots). */
  getAgentLoop: () => RestartCoordinatorAgentLoop | undefined
  /** Ask the process shutdown controller to exit (code 0 = clean reload). */
  interrupt: (code: number) => void
  /** True once a shutdown has started; the coordinator must not fire again. */
  isShuttingDown?: () => boolean
  logger?: { info?(message: string): void; warn?(message: string): void }
  /** Best-effort drain-log line (same sink as shutdown drain outcomes). */
  record?: (message: string) => void
  pollMs?: number
  waitCapMs?: number
}

/**
 * Start watching for `restart-request` under `dshHome`. Returns a stop
 * function; safe to call again (idempotent).
 */
export function startRestartCoordinator(options: RestartCoordinatorOptions): () => void {
  const { dshHome, getAgentLoop, interrupt } = options
  const pollMs = options.pollMs ?? RESTART_POLL_MS
  const waitCapMs = options.waitCapMs ?? RESTART_WAIT_CAP_MS
  const requestFile = join(dshHome, 'restart-request')
  const log = (message: string): void => {
    options.logger?.info?.(`dsh: restart: ${message}`)
    options.record?.(`restart coordinated: ${message}`)
  }

  let armed = false
  let waitingSince = 0
  let disposed = false
  const stateFile = join(dshHome, 'restart-pending')

  /** Best-effort state file for UI observers (restart banner): present while
   *  a coordinated restart is armed, absent otherwise. */
  function writeState(): void {
    try {
      writeFileSync(stateFile, JSON.stringify({ sinceMs: waitingSince, capMs: waitCapMs }))
    } catch {
      // Best-effort observability; never fail the restart over it.
    }
  }

  function clearState(): void {
    try {
      unlinkSync(stateFile)
    } catch {
      // Already gone.
    }
  }

  function stop(): void {
    if (!disposed) clearState()
    disposed = true
    clearInterval(timer)
  }

  const timer = setInterval(() => {
    if (disposed) return
    if (options.isShuttingDown?.()) {
      stop()
      return
    }
    if (!armed) {
      if (!existsSync(requestFile)) return
      try {
        unlinkSync(requestFile)
      } catch {
        // Another consumer (e.g. the daemon) won the race; keep the request.
      }
      armed = true
      waitingSince = Date.now()
      writeState()
      getAgentLoop()?.markDraining()
      log('request consumed; waiting for live turns to settle')
      return
    }
    const agentLoop = getAgentLoop()
    if (agentLoop === undefined || !agentLoop.hasLiveActivity()) {
      log(`all live turns idle after ${Math.round((Date.now() - waitingSince) / 1000)}s; exiting`)
      stop()
      interrupt(0)
      return
    }
    if (Date.now() - waitingSince >= waitCapMs) {
      log(`wait cap ${Math.round(waitCapMs / 1000)}s reached with live turns; draining now`)
      stop()
      interrupt(0)
      return
    }
  }, pollMs)

  return stop
}
