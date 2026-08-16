/**
 * dsh — restart coordinator.
 *
 * Turns an external `restart-request` file (touched by dsh-web-restart.sh, or
 * by the daemon on plugin-manifest / git-head reloads) into a *coordinated*
 * exit: the process waits only while a tool's external side effects are in
 * flight, then exits 0 through the ordinary shutdown path. Model wait, pre-step,
 * and declared read-only tool batches fast-exit as `turn/pending` on that path
 * (resume re-issues read calls, so waiting on them only widens the window).
 * The supervisor only waits (with a force-kill backstop). Exit timing lives in
 * the execution surface, not in the shell supervisor.
 *
 * Implementation notes:
 * - Process-level plain interval (not a cordis service): it must keep running
 *   while the tree is partially torn down and must not extend the shutdown
 *   force-exit budget.
 * - The agent loop is resolved lazily because it mounts during boot; one-shot
 *   surfaces without an agent loop exit immediately on request.
 * - Once armed, `markDraining()` refuses new turns (loop-level wake gate), so
 *   the wait cannot grow a new turn after the request is consumed.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Poll cadence for the request file and, once armed, for live activity. */
export const RESTART_POLL_MS = 1_000
/**
 * Cap for waiting on in-flight WRITE tools before falling back to the drain
 * path. Read-only tool batches never wait (fast-exit + resume re-issues the
 * call). 30s matches the agent drain grace: a tool that cannot settle within
 * one grace window is unlikely to settle at all, and pending-turn resume
 * re-issues the step after the new process boots — a longer wait only widens
 * the restart window without buying durability.
 */
export const RESTART_WAIT_CAP_MS = 30_000
/** Signal file the UI touches (POST /restart/immediate) to skip the wait. */
export const RESTART_IMMEDIATE_FILE = 'restart-immediate'

/** The agent-loop surface the coordinator needs (see AgentLoop). */
export interface RestartCoordinatorAgentLoop {
  markDraining(): void
  hasBlockingActivity(): boolean
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
  const immediateFile = join(dshHome, RESTART_IMMEDIATE_FILE)
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
    if (!disposed) {
      clearState()
      try {
        unlinkSync(immediateFile)
      } catch {
        // Already gone; a stale immediate signal must not leak into a later boot.
      }
    }
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
        // Best-effort consume. A lost race with the daemon still arms; TERM
        // then sets isShuttingDown and this coordinator stops.
      }
      armed = true
      waitingSince = Date.now()
      writeState()
      getAgentLoop()?.markDraining()
      log('request consumed; waiting for in-flight tools to settle')
    }
    if (existsSync(immediateFile)) {
      try {
        unlinkSync(immediateFile)
      } catch {
        // Lost the race; the next tick re-checks the file.
      }
      log('immediate restart requested; draining now')
      stop()
      interrupt(0)
      return
    }
    const agentLoop = getAgentLoop()
    if (agentLoop === undefined || !agentLoop.hasBlockingActivity()) {
      log(`no blocking activity after ${Math.round((Date.now() - waitingSince) / 1000)}s; exiting`)
      stop()
      interrupt(0)
      return
    }
    if (Date.now() - waitingSince >= waitCapMs) {
      log(`wait cap ${Math.round(waitCapMs / 1000)}s reached with in-flight tools; draining now`)
      stop()
      interrupt(0)
      return
    }
  }, pollMs)

  return stop
}
