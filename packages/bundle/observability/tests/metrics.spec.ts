/**
 * Session-ledger derived metrics: registry folding and the mounted /metrics
 * route. The registry is pure (deterministic render, sorted series); the
 * integration test mounts the real web server and fetches the endpoint.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply, inject, MetricsRegistry, METRIC_NAMES, name } from '../src/index.ts'

/** A minimal session object standing in for the live store entry. */
function stubSession(id: string, agentPreset?: string): Session {
  return {
    id: SessionId(id),
    header: { agentPreset },
    events: [],
  } as unknown as Session
}

function event(seed: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return { seq: 0, time: 0, ...seed } as SessionEvent
}

describe('MetricsRegistry', () => {
  it('counts active sessions by preset and drops them on leave', () => {
    const registry = new MetricsRegistry()
    registry.sessionEntered(stubSession('a', 'standard'))
    registry.sessionEntered(stubSession('b', 'standard'))
    registry.sessionEntered(stubSession('c'))
    expect(registry.render()).toContain('dsh_active_sessions{preset="standard"} 2')
    expect(registry.render()).toContain('dsh_active_sessions{preset="unset"} 1')
    registry.sessionLeft(stubSession('a', 'standard'))
    expect(registry.render()).toContain('dsh_active_sessions{preset="standard"} 1')
    expect(registry.render()).not.toContain('dsh_active_sessions{preset="standard"} 2')
  })

  it('tracks pending turns per session across start/pending/end', () => {
    const registry = new MetricsRegistry()
    const a = stubSession('a')
    const b = stubSession('b')
    registry.sessionEntered(a)
    registry.sessionEntered(b)
    registry.observe(a, event({ type: 'turn/start', data: { turn: 3 } }))
    registry.observe(a, event({ type: 'turn/pending', data: { turn: 3 } }))
    registry.observe(b, event({ type: 'turn/start', data: { turn: 1 } }))
    expect(registry.pendingTurnCount()).toBe(1)
    expect(registry.render()).toContain(`${METRIC_NAMES.turnPending} 1`)
    registry.observe(a, event({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }))
    expect(registry.pendingTurnCount()).toBe(0)
    expect(registry.render()).toContain(`${METRIC_NAMES.turnPending} 0`)
  })

  it('aggregates llm calls with provider/model/reasoning-effort labels', () => {
    const registry = new MetricsRegistry()
    const a = stubSession('a')
    registry.sessionEntered(a)
    registry.observe(a, event({
      type: 'request/header',
      data: {
        reason: 'initial',
        header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: ReasoningEffortId('max') } },
      },
    }))
    registry.observe(a, event({
      type: 'request/header',
      data: {
        reason: 'resume',
        header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: ReasoningEffortId('max') } },
      },
    }))
    registry.observe(a, event({
      type: 'request/header',
      data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    }))
    const render = registry.render()
    expect(render).toContain('dsh_llm_calls_total{provider="deepseek-official",model="deepseek-v4-flash",reasoning_effort="max"} 2')
    expect(render).toContain('dsh_llm_calls_total{provider="deepseek-official",model="deepseek-v4-flash"} 1')
  })

  it('folds assistant usage tokens by kind and counts tool calls and compactions', () => {
    const registry = new MetricsRegistry()
    const a = stubSession('a')
    registry.sessionEntered(a)
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { provider: 'mock', model: 'mock' },
    })
    registry.observe(a, event({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: assistant, usage: { inputTokens: 100, outputTokens: 25 } },
    }))
    registry.observe(a, event({ type: 'tool/call', data: { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{}' } }))
    registry.observe(a, event({ type: 'tool/call', data: { turn: 1, step: 1, callId: CallId('c2'), name: 'edit', arguments: '{}' } }))
    registry.observe(a, event({ type: 'session/end-seed', data: {} }))
    const render = registry.render()
    expect(render).toContain('dsh_llm_tokens_total{kind="input",model="mock",provider="mock"} 100')
    expect(render).toContain('dsh_llm_tokens_total{kind="output",model="mock",provider="mock"} 25')
    expect(render).toContain('dsh_tool_calls_total{tool="bash"} 1')
    expect(render).toContain('dsh_tool_calls_total{tool="edit"} 1')
    expect(render).toContain('dsh_compaction_total 1')
    expect(render).toContain('dsh_events_total{type="assistant/message"} 1')
    expect(render).toContain('dsh_events_total{type="tool/call"} 2')
  })

  it('renders in sorted, valid Prometheus text format', () => {
    const registry = new MetricsRegistry()
    const render = registry.render()
    // Gauge/counter series sorted by label string; trailing newline.
    expect(render.endsWith('\n')).toBe(true)
    expect(render).toContain('# TYPE dsh_active_sessions gauge')
    expect(render).toContain('# TYPE dsh_llm_calls_total counter')
    // No unsorted adjacent label pairs.
    const lines = render.trimEnd().split('\n').filter(line => line.startsWith('dsh_'))
    const labelLines = lines.filter(line => line.includes('{'))
    const keys = labelLines.map(line => line.slice(line.indexOf('{')))
    const sorted = [...keys].sort((a, b) => a.localeCompare(b))
    expect(keys).toEqual(sorted)
  })

  it('attributes llm usage by purpose across assistant, compaction, and session-title (R-DSH-01)', () => {
    const registry = new MetricsRegistry()
    const a = stubSession('a')
    registry.sessionEntered(a)
    // Assistant conversation: request/header + assistant/message usage.
    registry.observe(a, event({
      type: 'request/header',
      data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
    }))
    registry.observe(a, event({
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    }))
    // Compaction summarization carries its own route + usage.
    registry.observe(a, {
      seq: 0, time: 0,
      type: 'compaction/summary',
      data: {
        compactionId: 'c1' as never,
        summary: [{ type: 'text', text: 'sum' }],
        shadowedRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 500,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        llmStreamCall: true,
        rawOutput: [{ type: 'text', text: 'sum' }],
        usage: { inputTokens: 2000, outputTokens: 100 },
      },
    } as never)
    // Session-title auxiliary request carries a route, no usage.
    registry.observe(a, {
      seq: 0, time: 0,
      type: 'session/title-llm-request',
      data: {
        titleProvider: 'llm' as never,
        messageSeqs: [1],
        route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        system: 'title',
        messages: [],
        maxTokens: 64,
      },
    } as never)
    const usage = registry.summary().usage
    expect(usage).toContainEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      purpose: 'assistant',
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
    })
    expect(usage).toContainEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      purpose: 'compaction',
      calls: 1,
      inputTokens: 2000,
      outputTokens: 100,
      cacheReadTokens: 0,
    })
    expect(usage).toContainEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      purpose: 'session-title',
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('estimates cost from a configured price table only (R-DSH-01)', () => {
    const registry = new MetricsRegistry({
      'mock/mock': { inputPerMTok: 1, outputPerMTok: 2 },
    })
    const a = stubSession('a')
    registry.sessionEntered(a)
    registry.observe(a, event({
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'mock', model: 'mock' } }),
        usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      },
    }))
    // Priced route carries an estimated cost.
    expect(registry.summary().usage).toContainEqual({
      provider: 'mock',
      model: 'mock',
      purpose: 'assistant',
      calls: 0,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cost: 2, // 1 * $1/MTok + 0.5 * $2/MTok
    })
    // Unpriced route omits cost entirely.
    const bare = new MetricsRegistry()
    bare.sessionEntered(a)
    bare.observe(a, event({
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'other', model: 'm' } }),
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    }))
    const bareRow = bare.summary().usage.find(row => row.provider === 'other')
    expect(bareRow).toMatchObject({ provider: 'other', model: 'm', purpose: 'assistant' })
    expect('cost' in (bareRow ?? {})).toBe(false)
  })

  it('prices cache-read tokens at the cache-hit rate and folds them separately', () => {
    const registry = new MetricsRegistry({
      'ds/ds': { inputPerMTok: 1, inputCacheHitPerMTok: 0.05, outputPerMTok: 2 },
    })
    const a = stubSession('a')
    registry.sessionEntered(a)
    registry.observe(a, event({
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'ds', model: 'ds' } }),
        // inputTokens is net cache-miss; cacheReadTokens is billed separately.
        usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000 },
      },
    }))
    expect(registry.summary().usage).toContainEqual({
      provider: 'ds',
      model: 'ds',
      purpose: 'assistant',
      calls: 0,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 1_000_000,
      cost: 2.05, // 1*1 + 0.05*1 + 2*0.5
    })
    expect(registry.summary().tokens).toContainEqual({
      kind: 'cache-read',
      provider: 'ds',
      model: 'ds',
      purpose: 'assistant',
      tokens: 1_000_000,
    })
  })

  it('converts CNY prices to USD and applies peak multiplier by fold time', () => {
    const registry = new MetricsRegistry({
      'deepseek-official/deepseek-v4-flash': {
        inputPerMTok: 1.5,
        inputCacheHitPerMTok: 0.05,
        outputPerMTok: 4.5,
        currency: 'cny',
        peakMultiplier: 2,
      },
    })
    const a = stubSession('a')
    registry.sessionEntered(a)
    const observeUsage = (at: Date): void => {
      registry.observe(a, event({
        type: 'assistant/message',
        data: {
          turn: 1, step: 1,
          message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        },
      }), at)
    }
    // Off-peak weekday evening (Mon 23:00 Beijing): 1.5 + 4.5 = 6 CNY → USD /6.8.
    observeUsage(new Date('2026-08-17T15:00:00Z'))
    // Peak weekday morning (Mon 10:00 Beijing): (3.0 + 9.0) CNY → USD /6.8.
    observeUsage(new Date('2026-08-17T02:00:00Z'))
    const row = registry.summary().usage.find(r => r.provider === 'deepseek-official')
    expect(row?.cost).toBeCloseTo((6 + 12) / 6.8, 6)
  })
})

describe('the mounted /metrics route', () => {
  let ctx: Context | undefined
  afterEach(async () => { if (ctx !== undefined) { await ctx.fiber.dispose(); ctx = undefined } })

  it('serves derived metrics over the web server route', async () => {
    ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SessionStore)
    // The loader wraps modules into { name, inject, apply }; mirror that shape.
    await ctx.plugin({ name, inject, apply })
    const session = ctx.sessions.create(SessionId('metrics-session'), {
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), surfaceOp: 'append' },
      ],
    })
    // Live appends publish session/event and feed the process-scoped counters
    // (seed history only replays into the turn cursor, by design).
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'mock', model: 'mock' } }),
      usage: { inputTokens: 7, outputTokens: 2 },
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{}' })
    session.append('turn/pending', { turn: 1 })
    await ctx.sessions.flush(session)
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/metrics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    const body = await response.text()
    expect(body).toContain('dsh_active_sessions{preset="unset"} 1')
    expect(body).toContain('dsh_turn_pending 1')
    expect(body).toContain('dsh_llm_tokens_total{kind="input",model="mock",provider="mock"} 7')
    expect(body).toContain('dsh_tool_calls_total{tool="bash"} 1')
  })

  it('serves the structured summary the GUI tab consumes', async () => {
    ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(SessionStore)
    await ctx.plugin({ name, inject, apply })
    const session = ctx.sessions.create(SessionId('summary-session'), { seed: [] })
    session.append('turn/start', { turn: 1 })
    session.append('turn/pending', { turn: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'mock', model: 'mock' } }),
      usage: { inputTokens: 10, outputTokens: 3 },
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c2'), name: 'edit', arguments: '{}' })
    await ctx.sessions.flush(session)
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/observability/summary`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const summary = await response.json() as {
      activeSessions: { preset: string; count: number }[]
      pendingTurns: number
      llmCalls: { provider: string; model: string; reasoningEffort?: string; count: number }[]
      tokens: { kind: string; model?: string; tokens: number }[]
      toolCalls: { tool: string; count: number }[]
      totalEvents: number
    }
    expect(summary.activeSessions).toEqual([{ preset: 'unset', count: 1 }])
    expect(summary.pendingTurns).toBe(1)
    expect(summary.llmCalls).toEqual([]) // no request/header appended
    expect(summary.tokens).toContainEqual({ kind: 'input', provider: 'mock', model: 'mock', purpose: 'assistant', tokens: 10 })
    expect(summary.toolCalls).toEqual([{ tool: 'edit', count: 1 }])
    expect(summary.totalEvents).toBe(4)
  })
})
