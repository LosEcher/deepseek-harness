import { describe, expect, it, vi } from 'vitest'
import { runLosGrok } from '@deepseek-ai/dsh-subagent-los-grok'

const request = {
  prompt: [{ type: 'text', text: 'inspect the workspace' }],
  signal: new AbortController().signal,
  parent: { session: { header: { cwd: process.cwd() } } },
} as never

const config = {
  providerName: 'los-grok',
  baseUrl: 'http://los.test',
  authTokenEnv: 'LOS_AUTH_TOKEN',
  operatorTokenEnv: 'LOS_OPERATOR_TOKEN',
  timeoutMs: 30_000,
  outputLimitBytes: 128_000,
}

describe('LOS Grok runtime adapter', () => {
  it('fails closed when capability discovery does not advertise runnable Grok', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      runtimes: [{ kind: 'grok', implementation: 'planned', available: false }],
    }), { status: 200 }))

    await expect(runLosGrok(request, config, { fetchImpl }))
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

    await expect(runLosGrok(request, config, { fetchImpl }))
      .resolves.toEqual({ content: 'done', stopReason: 'completed' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
  })
})
