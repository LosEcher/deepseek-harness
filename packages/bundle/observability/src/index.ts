/**
 * @deepseek-ai/dsh-observability — session-ledger derived Prometheus metrics
 * over the shared core, exposed as an exact `/metrics` web route. Every figure
 * is a derived projection of the event stream (or of the live session set):
 * no new instrumentation, no persistence, and no runtime behavior change —
 * consistent with the observability borrow list (proposed 2026-08-16, P1).
 *
 * Default-off by composition: the bundle's patch row is only present in
 * profiles that mount it; the core never depends on it.
 *
 * @module @deepseek-ai/dsh-observability
 */

import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'observability'

/** Declared service dependencies: the session store feeds events; the web server hosts the route. */
export const inject = ['sessions', 'webServer']

/** Per-session turn cursor used to count resumable pending tails. */
interface TurnCursor {
  openTurn: number | null
  pendingTurn: number | null
}

/** Prometheus metric names this registry renders. */
export const METRIC_NAMES = {
  activeSessions: 'dsh_active_sessions',
  turnPending: 'dsh_turn_pending',
  compactionTotal: 'dsh_compaction_total',
  llmCallsTotal: 'dsh_llm_calls_total',
  llmTokensTotal: 'dsh_llm_tokens_total',
  toolCallsTotal: 'dsh_tool_calls_total',
  eventsTotal: 'dsh_events_total',
} as const

/**
 * Process-scoped derived metrics. Pure and dependency-free so it is directly
 * unit-testable; the plugin wires it to `session/created`, `session/disposed`,
 * `session/event`, and the `/metrics` route.
 */
export class MetricsRegistry {
  private readonly sessionsByPreset = new Map<string, number>()
  private readonly cursors = new Map<string, TurnCursor>()
  private readonly eventsByType = new Map<string, number>()
  private readonly llmCalls = new Map<string, number>()
  private readonly tokensByKind = new Map<string, number>()
  private readonly toolCalls = new Map<string, number>()
  private compactions = 0

  /** Track one live session (its preset labels its active-session series). */
  sessionEntered(session: Session): void {
    const preset = session.header.agentPreset ?? 'unset'
    this.sessionsByPreset.set(preset, (this.sessionsByPreset.get(preset) ?? 0) + 1)
    this.cursors.set(session.id, { openTurn: null, pendingTurn: null })
    // Replay the loaded history into the turn cursor only: seed events are
    // never re-published as `session/event`, but a resumed session may already
    // carry a `turn/pending` tail whose pending state must be counted. The
    // process-scoped counters (events, llm calls, tokens, tools, compactions)
    // deliberately stay since-process-start and are not backfilled.
    for (const event of session.events) this.foldCursor(session, event)
  }

  /** Drop one live session. */
  sessionLeft(session: Session): void {
    const preset = session.header.agentPreset ?? 'unset'
    const count = (this.sessionsByPreset.get(preset) ?? 1) - 1
    if (count <= 0) this.sessionsByPreset.delete(preset)
    else this.sessionsByPreset.set(preset, count)
    this.cursors.delete(session.id)
  }

  /** Advance one session's turn cursor from a turn-boundary event. */
  private foldCursor(session: Session, event: SessionEvent): void {
    const cursor = this.cursors.get(session.id)
    if (cursor === undefined) return
    switch (event.type) {
      case 'turn/start':
        cursor.openTurn = event.data.turn
        cursor.pendingTurn = null
        break
      case 'turn/pending':
        cursor.pendingTurn = event.data.turn
        break
      case 'turn/end':
        cursor.openTurn = null
        cursor.pendingTurn = null
        break
      default:
        break
    }
  }

  /** Fold one session event into the derived counters. */
  observe(session: Session, event: SessionEvent): void {
    this.eventsByType.set(event.type, (this.eventsByType.get(event.type) ?? 0) + 1)
    this.foldCursor(session, event)
    switch (event.type) {
      case 'session/end-seed':
        this.compactions += 1
        break
      case 'request/header': {
        const { provider, model, reasoningEffort } = event.data.header.config
        const key = `${provider}\u0000${model}\u0000${reasoningEffort ?? ''}`
        this.llmCalls.set(key, (this.llmCalls.get(key) ?? 0) + 1)
        break
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage === undefined) break
        const input = usage.inputTokens
        const output = usage.outputTokens
        if (Number.isFinite(input) && input >= 0) {
          this.tokensByKind.set('input', (this.tokensByKind.get('input') ?? 0) + input)
        }
        if (Number.isFinite(output) && output >= 0) {
          this.tokensByKind.set('output', (this.tokensByKind.get('output') ?? 0) + output)
        }
        break
      }
      case 'tool/call':
        this.toolCalls.set(event.data.name, (this.toolCalls.get(event.data.name) ?? 0) + 1)
        break
      default:
        break
    }
  }

  /** Number of live sessions currently parked on a `turn/pending` tail. */
  pendingTurnCount(): number {
    let count = 0
    for (const cursor of this.cursors.values()) {
      if (cursor.pendingTurn !== null) count += 1
    }
    return count
  }

  /** Render all series in Prometheus text exposition format (0.0.4). */
  render(): string {
    const lines: string[] = []
    const gauge = (name: string, help: string, samples: [string, number][]): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
      for (const [labels, value] of samples.sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${name}${labels} ${value}`)
      }
    }
    const counter = (name: string, help: string, samples: [string, number][]): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`)
      for (const [labels, value] of samples.sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${name}${labels} ${value}`)
      }
    }

    gauge(
      METRIC_NAMES.activeSessions,
      'Live sessions by agent preset.',
      [...this.sessionsByPreset.entries()]
        .map(([preset, value]) => [`{preset="${escapeLabel(preset)}"}`, value]),
    )
    gauge(
      METRIC_NAMES.turnPending,
      'Sessions with an open turn/pending tail awaiting resume.',
      [[ '', this.pendingTurnCount() ]],
    )
    counter(
      METRIC_NAMES.compactionTotal,
      'Compaction passes (session/end-seed markers) since process start.',
      [[ '', this.compactions ]],
    )
    counter(
      METRIC_NAMES.llmCallsTotal,
      'Model requests dispatched since process start, by route.',
      [...this.llmCalls.entries()]
        .map(([key, value]) => {
          const [provider, model, effort] = key.split('\u0000')
          const providerValue = provider ?? ''
          const modelValue = model ?? ''
          const effortValue = effort ?? ''
          const labels = effortValue === ''
            ? `{provider="${escapeLabel(providerValue)}",model="${escapeLabel(modelValue)}"}`
            : `{provider="${escapeLabel(providerValue)}",model="${escapeLabel(modelValue)}",reasoning_effort="${escapeLabel(effortValue)}"}`
          return [labels, value] as [string, number]
        }),
    )
    counter(
      METRIC_NAMES.llmTokensTotal,
      'Token usage recorded on assistant messages since process start, by kind.',
      [...this.tokensByKind.entries()]
        .map(([kind, value]) => [`{kind="${kind}"}`, value]),
    )
    counter(
      METRIC_NAMES.toolCallsTotal,
      'Tool invocations requested since process start, by tool name.',
      [...this.toolCalls.entries()]
        .map(([tool, value]) => [`{tool="${escapeLabel(tool)}"}`, value]),
    )
    counter(
      METRIC_NAMES.eventsTotal,
      'Session events observed since process start, by type.',
      [...this.eventsByType.entries()]
        .map(([type, value]) => [`{type="${escapeLabel(type)}"}`, value]),
    )
    return `${lines.join('\n')}\n`
  }
}

/** Escape a Prometheus label value: backslash, quote, and newline. */
function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

/** The composable plugin: wire the registry to session lifecycle + events and mount the route. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const registry = new MetricsRegistry()
    const stopCreated = ctx.on('session/created', (session) => { registry.sessionEntered(session) })
    const stopDisposed = ctx.on('session/disposed', (session) => { registry.sessionLeft(session) })
    const stopEvent = ctx.on('session/event', (session, event) => { registry.observe(session, event) })
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/metrics',
      handler: (_req, res) => {
        const body = registry.render()
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    })
    return () => {
      stopCreated()
      stopDisposed()
      stopEvent()
      disposeRoute()
    }
  })
}
