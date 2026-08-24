/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals, resumablePendingTurn, scanDanglingToolCalls, danglingToolResultSpecs, type ResumablePendingTurn } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeContextProjection } from './runtime-context.ts'
import { buildResumeInterruptionContext, collectTurnStreamText } from './resume-context.ts'
import { executeToolCalls } from './tool-calls.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

/**
 * Where the live turn currently sits, for phase-aware draining:
 * - `pre-step` — inbox claim / prompt assembly / dispatch, no model request issued
 * - `model-wait` — a model stream is in flight (no side effects)
 * - `tool-in-flight` — tool executions are running (external side effects)
 * - `idle` — no activity (driver exited or not started)
 */
export type TurnActivity = 'idle' | 'pre-step' | 'model-wait' | 'tool-in-flight'

/** Outcome of a phase-aware drain: fast-exit, clean boundary, or grace exceeded. */
export type DrainOutcome = 'idle' | 'pending' | 'timed-out'

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  /** Drain gate: when true, no new turn may start; in-flight work settles first. */
  private draining = false
  /** Open `turn/pending` tail this driver continues on first wake, if any. */
  private pendingResume: ResumablePendingTurn | undefined
  /** Turn already marked `turn/pending`, so the marker is written at most once. */
  private pendingMarkedTurn: number | null = null
  /** A2/A3: turn number claimed by resume, kept until the first resumed step. */
  private resumeTurn: number | null = null
  /** A2/A3: interruption context injected exactly once on the first resumed step. */
  private resumeContextInjected = false
  /**
   * Fine-grained stage of the live turn, used by phase-aware draining to
   * decide fast-exit (no side effects) vs wait (tool in flight). Set at the
   * stage boundaries inside {@link turn}/{@link step}; reset to `idle` when
   * the driver exits.
   */
  private activity: TurnActivity = 'idle'
  /**
   * Side-effect class of the in-flight tool batch, for restart coordination.
   * `'read'` when every in-flight call is a declared read-only tool (safe to
   * fast-exit to `turn/pending` immediately); `'write'` when any call may
   * leave external side effects half-applied. Reclassified at each tool
   * batch boundary; meaningless when {@link activity} is not `tool-in-flight`.
   */
  private inFlightSideEffect: 'read' | 'write' = 'write'
  /**
   * O6 (targeted abort): wall-clock start of the current in-flight write
   * batch, for judging which machine is stuck. 0 while not blocking.
   */
  private blockingSince = 0

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  private readonly runtimeContext: RuntimeContextProjection

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.pendingResume = resumablePendingTurn(session.events)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    if (this.draining) return
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /**
   * Close the turn gate: wake is refused. Unlike {@link drainToIdle} this
   * never waits. A coordinated restart polls {@link hasBlockingActivity}.
   */
  markDraining(): void {
    this.draining = true
  }

  /**
   * Reopen the turn gate after an armed restart that did not actually exit
   * (failed interrupt, supervisor race). Draining has no other reset path —
   * without this, the process lifetime is wedged and every new wake is
   * silently refused.
   */
  clearDraining(): void {
    this.draining = false
  }

  /** True while a turn is live (pre-step / model-wait / tool-in-flight). */
  hasLiveActivity(): boolean {
    return this.phase.kind !== 'idle'
  }

  /**
   * True while a tool's external side effects are in flight. Model wait and
   * pre-step are not blocking: a coordinated restart may fast-exit them.
   * A declared read-only tool batch also does not block: interruption is
   * side-effect-free, so the restart fast-exits to `turn/pending` and resume
   * re-issues the call.
   */
  hasBlockingActivity(): boolean {
    return this.activity === 'tool-in-flight' && this.inFlightSideEffect === 'write'
  }

  /**
   * How long the current in-flight write batch has been blocking (0 when not
   * blocking). Lets the loop abort only the stuck machine instead of every
   * live machine's write tool (O5 companion finding D).
   */
  blockingAgeMs(): number {
    if (this.activity !== 'tool-in-flight' || this.inFlightSideEffect !== 'write') return 0
    return Math.max(0, Date.now() - this.blockingSince)
  }

  /**
   * O6: abort the in-flight write tool batch when the restart coordinator
   * judges it stuck (blocking past {@link STUCK_JUDGE_MS}). Aborting the phase
   * signal makes cooperative tools fail fast; `activityDone` settles and the
   * coordinator's next poll sees no blocking activity and exits. A tool that
   * ignores its signal keeps running and is bounded by the coordinator's wait
   * cap instead. The turn stays open as `turn/pending` only when the drain
   * fast-exit runs; a hard abort closes it as `aborted` (resume re-derives a
   * clean boundary via repair). Best-effort: a live turn is required.
   */
  abortBlockingActivity(): void {
    if (this.phase.kind !== 'running' || this.activity !== 'tool-in-flight') return
    this.phase.abort.abort({ kind: 'hook', reason: 'restart-stuck-tool' } satisfies AgentCancelCause)
  }

  /** True when the loaded log has an open `turn/pending` tail to continue. */
  hasPendingResume(): boolean {
    return this.pendingResume !== undefined
  }

  /**
   * Start the driver so an open `turn/pending` tail continues after publication.
   * No-op when there is no pending tail, the driver is already live, or the
   * drain gate is closed.
   */
  resumeOpenTurn(): void {
    if (this.pendingResume === undefined || this.phase.kind !== 'idle') return
    this.wakeDriver()
  }

  /**
   * Phase-aware drain (方案 C, step 1). The decision depends on where the live
   * turn currently sits, not on a fixed grace:
   *
   * - `idle` / `pre-step` / `model-wait` — no side effects in flight: return
   *   `'pending'` immediately (fast exit) and mark the turn `turn/pending` so
   *   crash repair keeps it resumable instead of synthesizing `interrupted`.
   * - `tool-in-flight` — a tool's external side effects are at stake: wait for
   *   the activity to settle at a `completed` turn/end, bounded by `timeoutMs`
   *   (the caller then aborts on timeout).
   *
   * Waking input during the drain stays in the durable inbox and is handled
   * after resume.
   */
  async drainToIdle(timeoutMs: number): Promise<DrainOutcome> {
    this.draining = true
    if (this.phase.kind === 'idle') return 'idle'
    if (this.activity === 'model-wait') {
      // A model stream in flight has no side effects: fast-exit and keep the
      // turn open (turn/pending) for post-resume rebuild.
      this.markPending()
      return 'pending'
    }
    if (this.activity === 'pre-step') {
      // O5: the pre-step gap (the instant right after a write tool settles,
      // before the next model request) is a live turn — cutting it as 'idle'
      // closes the turn as aborted and loses the in-flight work. Mark it
      // resumable instead: a resumed turn re-claims whatever is still pending,
      // and the empty-input guard in turn() closes the turn cleanly when
      // nothing remains (the claimed input was consumed by its splice).
      this.markPending()
      return 'pending'
    }
    if (this.activity === 'tool-in-flight' && this.inFlightSideEffect === 'read') {
      // A declared read-only batch has no external side effects: fast-exit to
      // turn/pending just like model-wait. Resume re-issues the call, so
      // waiting for it to settle would only extend the restart window.
      this.markPending()
      return 'pending'
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const settled = await Promise.race([
        this.activityDone.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      if (settled) {
        // One macrotask tick so the driver's finally-block phase transition
        // lands before the caller proceeds to cancel/dispose.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
      // activityDone settles exactly when the driver (or maintenance job) has
      // run its finally block, which re-enters the idle phase — so `settled`
      // alone is the phase guarantee.
      return settled ? 'idle' : 'timed-out'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Append the resumable-tail marker for the open turn (best-effort, idempotent). */
  /**
   * Append the resumable-tail marker for the open turn (best-effort,
   * idempotent). Two dedupe layers: the instance-level `pendingMarkedTurn`
   * (this driver already marked this turn) and the durable log itself — a
   * previous process instance may already have written `turn/pending` for the
   * same turn before this instance resumed it, so the marker is written at
   * most once across instances (event-sourced dedupe, mirrors the
   * `dsh-session-store` lease "a second writer cannot acquire a live session"
   * rule for the fast-exit tail).
   */
  private markPending(): void {
    if (this.phase.kind !== 'running') return
    const turn = this.phase.turn
    if (this.pendingMarkedTurn === turn) return
    // Cross-instance dedupe: a resumed pending turn may already carry its
    // marker in the durable log. Scan only the session's committed events —
    // write-behind batches are flushed by the drain fence before process exit,
    // and a stale marker for the SAME turn is exactly what this dedupes.
    if (this.session.events.some(event => event.type === 'turn/pending' && event.data.turn === turn)) {
      this.pendingMarkedTurn = turn
      return
    }
    this.pendingMarkedTurn = turn
    try {
      this.session.append('turn/pending', { turn })
    } catch (error: unknown) {
      this.loopCtx.logger.warn(
        `agent "${this.id}": turn/pending marker not appended: ${errorChain(error)}`,
      )
    }
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        this.activity = 'idle'
        this.blockingSince = 0
        if (!this.draining && wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const resuming = this.pendingResume
    let turn: number
    if (resuming !== undefined) {
      if (resuming.openStep !== null) {
        // A resumed open step may carry assistant tool calls whose durable
        // results were lost when the previous process was drained mid-flight
        // (the drain fast-exit writes turn/pending but cannot wait for a
        // write-side tool, and crash repair deliberately skips pending tails).
        // Answer every dangling call with a synthesized TOOL_OUTCOME_UNKNOWN
        // result BEFORE closing the step: otherwise the re-derived transcript
        // contains an assistant tool_calls message with no tool response and
        // the provider rejects the request with INVALID_REQUEST — and the
        // dangling call poisons every later turn in the session.
        for (const spec of danglingToolResultSpecs(
          scanDanglingToolCalls(this.session.events).filter(call => call.turn === resuming.turn),
        )) {
          try {
            this.session.append(spec.type, spec.data, {
              surfaceOp: spec.surfaceOp,
              ...spec.sourceEventSeqs !== undefined ? { sourceEventSeqs: spec.sourceEventSeqs } : {},
            })
          } catch (error: unknown) {
            this.throwError(error)
          }
        }
        try {
          this.session.append('step/end', { turn: resuming.turn, step: resuming.openStep })
        } catch (error: unknown) {
          this.throwError(error)
        }
      }
      this.pendingResume = undefined
      this.resumeTurn = resuming.turn
      turn = resuming.turn
      phase.turn = turn
      phase.step = resuming.nextStep - 1
    } else {
      turn = phase.turn + 1
      try {
        this.session.append('turn/start', { turn })
      } catch (error: unknown) {
        this.throwError(error)
      }
      phase.turn = turn
    }
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = resuming !== undefined ? 'next-step' : 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        this.activity = 'pre-step'
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // O5 resume guard: a resumed pre-step drain with no step started yet
        // may find nothing pending (the pre-drain claim splice already
        // consumed the input). Close the turn cleanly instead of issuing an
        // empty model request.
        if (resuming !== undefined && phase.step === 0 && decision.messages.length === 0 && !this.inbox.hasPending) {
          turnEnds = { kind: 'completed' }
          return false
        }
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const stepEnd = await this.step(decision.assembly)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      if (this.draining) {
        // A failure inside the lifecycle drain window (supervisor teardown is
        // already closing the turn gate) is attributed to the shutdown, not
        // the business error: the restart must resume at a clean boundary.
        turnEnds = { kind: 'aborted', reason: { kind: 'disposed' } }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (this.draining || !this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    // A2/A3: on the first resumed step, extend the system prompt with the
    // interruption context ("host update, user did NOT cancel") plus any
    // already-produced streamed text (checkpoint continuation). Messages stay
    // untouched, so the log-derived transcript invariant holds; the extended
    // system is folded into the request header by buildRequest.
    let system = renderPrompt(assembly)
    if (this.resumeTurn !== null && !this.resumeContextInjected) {
      this.resumeContextInjected = true
      const produced = collectTurnStreamText(this.session.events, this.resumeTurn)
      this.resumeTurn = null
      system = `${system}\n\n${buildResumeInterruptionContext(produced)}`
    }

    while (true) {
      // Transcript-pairing defense: any assistant tool-call left dangling
      // without a durable tool/result (a tool killed mid-flight outside the
      // resume path, a historical hole from an earlier crash) makes
      // deriveMessages emit a provider-invalid transcript and every request
      // fail with INVALID_REQUEST. Synthesize the unknown outcome before
      // building the request. The scan is idempotent — once a result exists
      // the call no longer dangles — so repeated steps pay only the fold cost.
      const dangling = scanDanglingToolCalls(this.session.events)
      if (dangling.length > 0) {
        for (const spec of danglingToolResultSpecs(dangling)) {
          signal.throwIfAborted()
          this.session.append(spec.type, spec.data, {
            surfaceOp: spec.surfaceOp,
            ...spec.sourceEventSeqs !== undefined ? { sourceEventSeqs: spec.sourceEventSeqs } : {},
          })
        }
      }
      // A2/A3 resume context: the first step of a resumed pending turn is
      // injected with "interrupted by host update — user did NOT cancel it",
      // plus any already-produced streamed text (checkpoint continuation),
      // so the model continues instead of misreading or repeating output.
      const messages = this.session.deriveMessages()
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, messages, signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        this.activity = 'model-wait'
        for await (const chunk of stream) {
          signal.throwIfAborted()
          chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
          assembler.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (signal.aborted) {
          const content = assembler.interruptedBlocks()
          if (content.length > 0) {
            this.session.append('assistant/message', {
              turn,
              step,
              message: createAssistantMessage({
                content,
                source: { provider: request.provider, model: request.model },
              }),
              interrupted: true,
              ...assembler.usage === undefined ? {} : { usage: assembler.usage },
            }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
          }
        }
        throw error
      }
      signal.throwIfAborted()
      this.activity = 'pre-step'
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      this.activity = 'tool-in-flight'
      // Classify the batch for restart coordination: any call that is not a
      // declared read-only tool makes the whole batch 'write' (fail-closed).
      this.inFlightSideEffect = toolCalls.every(call => this.loopCtx.tools.executionSideEffect({
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
        agent: this,
        signal,
      }) === 'read') ? 'read' : 'write'
      // O6: anchor the blocking window so the loop can abort the machine that
      // has been stuck the longest instead of every live write tool.
      if (this.inFlightSideEffect === 'write') this.blockingSince = Date.now()
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      this.blockingSince = 0
      this.activity = 'pre-step'
      return concluded ? { kind: 'completed' } : null
    }
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }

    const contextWindow = preparedCall?.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
