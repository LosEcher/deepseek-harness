/**
 * HostStatusRuntime unit coverage: poll cadence, restart-window projection,
 * unreachable projection on failure, and teardown reset. Uses a hand-rolled
 * IApiClient stub so the poll behavior is fully scripted (the fake-api host
 * fixture in this package can drive it too, but a closed stub keeps these
 * cases about the service, not the carrier).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { HOST_STATUS_POLL_MS, HostStatusRuntime } from '../src/client/host-status/service.ts'

function describeResponse(restartPending?: { sinceMs: number; capMs: number }): RpcResponse<{
  version: string
  cwd: string
  attachedSessions: number
  canOpenPath: boolean
  restartPending?: { sinceMs: number; capMs: number }
}> {
  return {
    rpcId: RpcId('r'),
    result: {
      ok: true as const,
      value: {
        version: '0-test',
        cwd: '/tmp',
        attachedSessions: 0,
        canOpenPath: false,
        ...restartPending === undefined ? {} : { restartPending },
      },
    },
  }
}

function stubApi(handler: () => unknown): IApiClient {
  return {
    host: {
      describe: () => Promise.resolve(handler() as never),
    },
  } as unknown as IApiClient
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
}

describe('HostStatusRuntime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('projects no restart window and reachable=true on a clean describe', async () => {
    const ctx = new Context()
    const runtime = new HostStatusRuntime(ctx, stubApi(() => describeResponse()))
    runtime.start()
    await settle()
    expect(runtime.status.getSnapshot()).toEqual({ restartPending: undefined, reachable: true })
    runtime.stop()
  })

  it('projects the armed restart window from describe', async () => {
    const ctx = new Context()
    const runtime = new HostStatusRuntime(ctx, stubApi(() => describeResponse({ sinceMs: 123, capMs: 30_000 })))
    runtime.start()
    await settle()
    expect(runtime.status.getSnapshot()).toEqual({
      restartPending: { sinceMs: 123, capMs: 30_000 },
      reachable: true,
    })
    runtime.stop()
  })

  it('projects unreachable on a failed describe and recovers on the next poll', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    let fail = true
    const runtime = new HostStatusRuntime(ctx, stubApi(() => {
      if (fail) throw new Error('carrier down')
      return describeResponse()
    }))
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.status.getSnapshot()).toEqual({ restartPending: undefined, reachable: false })
    fail = false
    await vi.advanceTimersByTimeAsync(HOST_STATUS_POLL_MS)
    expect(runtime.status.getSnapshot()).toEqual({ restartPending: undefined, reachable: true })
    runtime.stop()
  })

  it('stop() resets to the disconnected projection and halts polling', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const describe = vi.fn(() => describeResponse({ sinceMs: 1, capMs: 2 }))
    const runtime = new HostStatusRuntime(ctx, stubApi(() => describe()))
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.status.getSnapshot().restartPending).toEqual({ sinceMs: 1, capMs: 2 })
    runtime.stop()
    expect(runtime.status.getSnapshot()).toEqual({ restartPending: undefined, reachable: false })
    const calls = describe.mock.calls.length
    await vi.advanceTimersByTimeAsync(HOST_STATUS_POLL_MS * 3)
    expect(describe.mock.calls.length).toBe(calls)
  })

  it('poll responses never overlap (a slow describe skips the next tick)', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    let inFlight: Promise<void> | undefined
    let release!: () => void
    const runtime = new HostStatusRuntime(ctx, stubApi(() => {
      if (inFlight !== undefined) throw new Error('overlap!')
      inFlight = new Promise<void>((resolve) => { release = resolve })
      return inFlight.then(() => describeResponse())
    }))
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HOST_STATUS_POLL_MS) // tick while in flight
    expect(runtime.status.getSnapshot()).toEqual({ restartPending: undefined, reachable: false })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.status.getSnapshot()).toEqual({ restartPending: undefined, reachable: true })
    runtime.stop()
  })
})
