import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  snapshotSubagentDescriptor,
  type ResolvedSubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { runLosGrok, startLosGrokRun } from '../src/run.ts'

const config = {
  providerName: 'los-grok',
  baseUrl: 'http://los.test',
  authTokenEnv: 'LOS_AUTH_TOKEN',
  operatorTokenEnv: 'LOS_OPERATOR_TOKEN',
  timeoutMs: 30_000,
  outputLimitBytes: 128_000,
}

function request(
  overrides: Partial<ResolvedSubagentStartRequest> = {},
): ResolvedSubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'inspect the workspace' }],
    signal: new AbortController().signal,
    parent: { session: { header: { cwd: process.cwd() } } } as ResolvedSubagentStartRequest['parent'],
    descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'los-grok' }),
    ...overrides,
  }
}

describe('LOS Grok runtime adapter', () => {
  it('fails closed when capability discovery does not advertise runnable Grok', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      runtimes: [{ kind: 'grok', implementation: 'planned', available: false }],
    }), { status: 200 }))

    await expect(runLosGrok(request(), config, { fetchImpl }))
      .resolves.toMatchObject({ stopReason: 'error', diagnostic: expect.stringContaining('LOS Grok unavailable:') })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('translates the bounded LOS SSE lifecycle into a completed result', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runtimes: [{ kind: 'grok', implementation: 'runnable', available: true }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'event: runtime.started',
        'data: {"type":"runtime.started"}',
        '',
        'event: runtime.output',
        'data: {"type":"runtime.output","content":"done"}',
        '',
        'event: runtime.completed',
        'data: {"type":"runtime.completed","exitCode":0}',
        '',
      ].join('\n'), { status: 200 }))

    await expect(runLosGrok(request(), config, { fetchImpl }))
      .resolves.toEqual({ content: 'done', stopReason: 'completed' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('maps caller cancellation to an aborted result without invoking LOS', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const controller = new AbortController()
    controller.abort()

    await expect(runLosGrok(request({ signal: controller.signal }), config, { fetchImpl }))
      .resolves.toEqual({ content: '', stopReason: 'aborted' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('publishes a remote run whose result carries the captured SSE text', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runtimes: [{ kind: 'grok', implementation: 'runnable', available: true }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'event: runtime.output',
        'data: {"type":"runtime.output","content":"done"}',
        '',
        'event: runtime.completed',
        'data: {"type":"runtime.completed","exitCode":0}',
        '',
      ].join('\n'), { status: 200 }))

    const run = startLosGrokRun(request(), config, { fetchImpl })
    expect(run.localAgent).toBeUndefined()
    expect(run.id).toMatch(/^los-grok:los-grok:/)
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'done' }],
      stopReason: 'completed',
    })
    await run.dispose()
    expect(SessionId(String(run.id))).toBe(run.id)
  })
})
