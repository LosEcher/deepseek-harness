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
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'observability'

/** Declared service dependencies: the session store feeds events; the web server hosts the route. */
export const inject = ['sessions', 'webServer']

/** Plugin config: an optional USD price table enables cost estimation. */
export interface Config {
  /** USD per 1M tokens, keyed by `provider/model` route. */
  prices?: LlmPriceTable
}

export const Config: z<Config> = z.object({
  prices: z.dict(z.object({
    inputPerMTok: z.number(),
    outputPerMTok: z.number(),
  }), z.string()).default({}),
})
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

/** Structured metrics snapshot served to the GUI summary endpoint. */
export interface ObservabilitySummary {
  activeSessions: { preset: string; count: number }[]
  pendingTurns: number
  compactions: number
  llmCalls: { provider: string; model: string; reasoningEffort?: string; purpose: LlmPurpose; count: number }[]
  tokens: { kind: 'input' | 'output'; provider?: string; model?: string; purpose: LlmPurpose; tokens: number }[]
  toolCalls: { tool: string; count: number }[]
  events: { type: string; count: number }[]
  totalEvents: number
  /** Per-(provider, model, purpose) usage cube: calls, tokens, and estimated cost when a price table is configured. */
  usage: { provider: string; model: string; purpose: LlmPurpose; calls: number; inputTokens: number; outputTokens: number; cost?: number }[]
}

/**
 * Provider-neutral classification of an LLM call's purpose, mirroring
 * {@link GenerateOptions.purpose}: ordinary conversation turns (`assistant`),
 * compaction summarization, and auxiliary session-title requests. R-DSH-01:
 * per-purpose attribution is the precondition for cost explainability.
 */
export type LlmPurpose = 'assistant' | 'compaction' | 'session-title'

/**
 * Local shape of the plugin-extended `compaction/summary` event (declared
 * here to avoid a hard dependency on dsh-compaction; only the attribution
 * fields are read).
 */
interface CompactionSummaryEvent {
  type: 'compaction/summary'
  data: {
    provider: string
    model: string
    usage?: { inputTokens: number; outputTokens: number }
  }
}

/**
 * Local shape of the plugin-extended `session/title-llm-request` event
 * (declared here to avoid a hard dependency on dsh-session-title-llm).
 */
interface TitleLlmRequestEvent {
  type: 'session/title-llm-request'
  data: {
    route: { provider: string; model: string }
  }
}

/** The event union the registry folds: core events plus the two attributed plugin events. */
type FoldedEvent = SessionEvent | CompactionSummaryEvent | TitleLlmRequestEvent

/** Per-provider/model price table (USD per 1M tokens) for cost estimation. */
export interface LlmPriceTable {
  [route: string]: { inputPerMTok: number; outputPerMTok: number }
}

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
  private readonly usageByPurpose = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>()
  private compactions = 0
  private readonly prices: LlmPriceTable

  /** Create the registry; an optional price table enables cost estimation. */
  constructor(prices: LlmPriceTable = {}) {
    this.prices = prices
  }

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
  observe(session: Session, event: FoldedEvent): void {
    this.eventsByType.set(event.type, (this.eventsByType.get(event.type) ?? 0) + 1)
    // The turn cursor only understands core turn-boundary events; the two
    // attributed plugin events are log-only and never turn-boundary markers.
    this.foldCursor(session, event as SessionEvent)
    switch (event.type) {
      case 'session/end-seed':
        this.compactions += 1
        break
      case 'request/header': {
        // Main-loop conversation requests carry no GenerateOptions.purpose, so
        // they attribute to the `assistant` purpose (R-DSH-01).
        const { provider, model, reasoningEffort } = event.data.header.config
        const key = `${provider}\u0000${model}\u0000${reasoningEffort ?? ''}`
        this.llmCalls.set(key, (this.llmCalls.get(key) ?? 0) + 1)
        this.foldUsage(provider, model, 'assistant', 1, 0, 0)
        break
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage === undefined) break
        // Token usage folds by provider/model route (the usage/cost cube
        // projection): kind + route form the series key. Main-loop responses
        // attribute to the `assistant` purpose.
        const source = event.data.message.source
        const provider = source.provider
        const model = source.model
        const input = usage.inputTokens
        const output = usage.outputTokens
        const finiteInput = Number.isFinite(input) && input >= 0 ? input : 0
        const finiteOutput = Number.isFinite(output) && output >= 0 ? output : 0
        this.foldUsage(provider, model, 'assistant', 0, finiteInput, finiteOutput)
        if (finiteInput > 0) {
          this.tokensByKind.set(`input\u0000${provider}\u0000${model}`, (this.tokensByKind.get(`input\u0000${provider}\u0000${model}`) ?? 0) + finiteInput)
        }
        if (finiteOutput > 0) {
          this.tokensByKind.set(`output\u0000${provider}\u0000${model}`, (this.tokensByKind.get(`output\u0000${provider}\u0000${model}`) ?? 0) + finiteOutput)
        }
        break
      }
      case 'compaction/summary': {
        // Compaction summarization calls carry their own provider/model/usage
        // on the summary event (they do not pass through request/header).
        const { provider, model } = event.data
        this.foldUsage(provider, model, 'compaction', 1, 0, 0)
        const usage = event.data.usage
        if (usage !== undefined) {
          const input = usage.inputTokens
          const output = usage.outputTokens
          const finiteInput = Number.isFinite(input) && input >= 0 ? input : 0
          const finiteOutput = Number.isFinite(output) && output >= 0 ? output : 0
          this.foldUsage(provider, model, 'compaction', 0, finiteInput, finiteOutput)
          if (finiteInput > 0) {
            this.tokensByKind.set(`input\u0000${provider}\u0000${model}`, (this.tokensByKind.get(`input\u0000${provider}\u0000${model}`) ?? 0) + finiteInput)
          }
          if (finiteOutput > 0) {
            this.tokensByKind.set(`output\u0000${provider}\u0000${model}`, (this.tokensByKind.get(`output\u0000${provider}\u0000${model}`) ?? 0) + finiteOutput)
          }
        }
        break
      }
      case 'session/title-llm-request': {
        // Auxiliary title requests are logged with their route but no usage
        // (they are dispatched before token accounting exists); count the call.
        const { provider, model } = event.data.route
        this.foldUsage(provider, model, 'session-title', 1, 0, 0)
        break
      }
      case 'tool/call':
        this.toolCalls.set(event.data.name, (this.toolCalls.get(event.data.name) ?? 0) + 1)
        break
      default:
        break
    }
  }

  /** Fold one (provider, model, purpose) row of the usage cube. */
  private foldUsage(
    provider: string,
    model: string,
    purpose: LlmPurpose,
    calls: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const key = `${provider}\u0000${model}\u0000${purpose}`
    const row = this.usageByPurpose.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0 }
    row.calls += calls
    row.inputTokens += inputTokens
    row.outputTokens += outputTokens
    this.usageByPurpose.set(key, row)
  }

  /** Number of live sessions currently parked on a `turn/pending` tail. */
  pendingTurnCount(): number {
    let count = 0
    for (const cursor of this.cursors.values()) {
      if (cursor.pendingTurn !== null) count += 1
    }
    return count
  }

  /** Structured snapshot for the GUI summary endpoint (same fold as {@link render}). */
  summary(): ObservabilitySummary {
    return {
      activeSessions: [...this.sessionsByPreset.entries()]
        .map(([preset, count]) => ({ preset, count }))
        .sort((a, b) => b.count - a.count),
      pendingTurns: this.pendingTurnCount(),
      compactions: this.compactions,
      llmCalls: [...this.llmCalls.entries()]
        .map(([key, count]) => {
          const [provider, model, effort] = key.split('\u0000')
          return {
            provider: provider ?? '',
            model: model ?? '',
            ...(effort !== undefined && effort !== '' ? { reasoningEffort: effort } : {}),
            purpose: 'assistant' as const,
            count,
          }
        })
        .sort((a, b) => b.count - a.count),
      tokens: [...this.tokensByKind.entries()]
        .map(([key, tokens]) => {
          const [kind, provider, model] = key.split('\u0000')
          return {
            kind: kind as 'input' | 'output',
            ...(provider !== undefined && provider !== '' ? { provider } : {}),
            ...(model !== undefined && model !== '' ? { model } : {}),
            purpose: 'assistant' as const,
            tokens,
          }
        })
        .sort((a, b) => b.tokens - a.tokens),
      toolCalls: [...this.toolCalls.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count),
      events: [...this.eventsByType.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12),
      totalEvents: [...this.eventsByType.values()].reduce((sum, count) => sum + count, 0),
      usage: [...this.usageByPurpose.entries()]
        .map(([key, row]) => {
          const [provider, model, purpose] = key.split('\u0000')
          const entry = {
            provider: provider ?? '',
            model: model ?? '',
            purpose: purpose as LlmPurpose,
            calls: row.calls,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
          }
          const cost = this.estimateCost(entry.provider, entry.model, row)
          return cost === undefined ? entry : { ...entry, cost }
        })
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    }
  }

  /** Estimate USD cost for one usage row when a price table is configured. */
  private estimateCost(
    provider: string,
    model: string,
    row: { inputTokens: number; outputTokens: number },
  ): number | undefined {
    const route = `${provider}/${model}`
    const price = this.prices[route]
    if (price === undefined) return undefined
    const input = row.inputTokens / 1_000_000 * price.inputPerMTok
    const output = row.outputTokens / 1_000_000 * price.outputPerMTok
    return Math.round((input + output) * 1_000_000) / 1_000_000
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
      'Token usage recorded on assistant messages since process start, by route and kind.',
      [...this.tokensByKind.entries()]
        .map(([key, value]) => {
          const [kind, provider, model] = key.split('\u0000')
          const providerValue = provider ?? ''
          const modelValue = model ?? ''
          const labels = providerValue === '' && modelValue === ''
            ? `{kind="${kind}"}`
            : `{kind="${kind}",model="${escapeLabel(modelValue)}",provider="${escapeLabel(providerValue)}"}`
          return [labels, value] as [string, number]
        }),
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
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => {
    const registry = new MetricsRegistry(config.prices ?? {})
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
    const disposeSummary = ctx.webServer.register({
      kind: 'exact',
      path: '/observability/summary',
      handler: (_req, res) => {
        const body = JSON.stringify(registry.summary())
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
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
      disposeSummary()
    }
  })
}
