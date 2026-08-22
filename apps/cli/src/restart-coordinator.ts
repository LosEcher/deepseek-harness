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
/**
 * O6: 卡死工具判定窗口（ms）。armed 后若 write 工具在途持续超过该窗口仍未
 * settle，判定「可能卡死」并主动 abort（协作式工具快速失败，activityDone 提前
 * settle，下一轮 no-blocking 即退出）。对比 cap 兜底（30s 后再 drain），把忙碌
 * 重启窗口从 ~60s 压到 ~15s。不协作工具（忽略 abort）仍由 cap 兜底。
 */
export const STUCK_JUDGE_MS = 5_000
/** Signal file the UI touches (POST /restart/immediate) to skip the wait. */
export const RESTART_IMMEDIATE_FILE = 'restart-immediate'
/** Exit trace written on the coordinated-restart path, read by the next boot. */
export const RESTART_EXITED_FILE = 'restart-exited'

/** The agent-loop surface the coordinator needs (see AgentLoop). */
export interface RestartCoordinatorAgentLoop {
  markDraining(): void
  hasBlockingActivity(): boolean
  /** O6: best-effort abort of the in-flight write tool when judged stuck. */
  abortBlockingActivity?(): void
  /**
   * Reopen the turn gate if the armed restart does not actually exit
   * (failed interrupt, supervisor race) — otherwise live sessions stay
   * silently wedged for the process lifetime.
   */
  clearDraining?(): void
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
  /** O6: stuck-tool judgment window; defaults to {@link STUCK_JUDGE_MS}. */
  stuckJudgeMs?: number
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
  const exitedFile = join(dshHome, RESTART_EXITED_FILE)
  const log = (message: string): void => {
    options.logger?.info?.(`dsh: restart: ${message}`)
    options.record?.(`restart coordinated: ${message}`)
  }

  let armed = false
  let waitingSince = 0
  let disposed = false
  // O6: 连续在途（write 工具卡死）的起始时刻；0 = 当前无阻塞。abort 只触发一次。
  let blockingSince = 0
  let stuckAborted = false
  const stuckJudgeMs = options.stuckJudgeMs ?? STUCK_JUDGE_MS
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
      if (armed) {
        // Exit trace for the next boot: the shell surfaces a one-shot
        // "restart completed" notice once the host comes back. Written only
        // on the coordinated-restart path (armed) — an external shutdown
        // must not look like a restart.
        try {
          writeFileSync(exitedFile, JSON.stringify({ exitedAt: Date.now() }))
        } catch {
          // Best-effort observability; never fail the restart over it.
        }
      }
      clearState()
      try {
        unlinkSync(immediateFile)
      } catch {
        // Already gone; a stale immediate signal must not leak into a later boot.
      }
      // O5 companion (C): if the armed restart does not actually exit (failed
      // interrupt, supervisor race), reopen the turn gate so live sessions are
      // not silently wedged for the process lifetime. Harmless on the normal
      // exit path — the process is about to terminate.
      getAgentLoop()?.clearDraining?.()
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
      // 无阻塞：复位卡死判定状态（供下一次 armed 窗口使用）。
      blockingSince = 0
      stuckAborted = false
      log(`no blocking activity after ${Math.round((Date.now() - waitingSince) / 1000)}s; exiting`)
      stop()
      interrupt(0)
      return
    }
    // O6: 卡死判定——write 工具在途持续超过 stuckJudgeMs 仍未 settle，主动 abort。
    if (blockingSince === 0) {
      blockingSince = Date.now()
    } else if (!stuckAborted && Date.now() - blockingSince >= stuckJudgeMs) {
      stuckAborted = true
      try {
        agentLoop.abortBlockingActivity?.()
        log(`stuck write tool judged after ${Math.round(stuckJudgeMs / 1000)}s; aborted, awaiting settle`)
      } catch {
        // Best-effort abort; the wait cap below still bounds the window.
      }
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
