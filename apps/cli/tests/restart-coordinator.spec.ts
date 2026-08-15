import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startRestartCoordinator,
  type RestartCoordinatorAgentLoop,
} from '../src/restart-coordinator.ts'

function fakeAgentLoop(busy: () => boolean): RestartCoordinatorAgentLoop {
  return {
    markDraining: vi.fn(),
    hasBlockingActivity: busy,
  }
}

const timers: ReturnType<typeof setInterval>[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const t of timers.splice(0)) clearInterval(t)
})

describe('restart coordinator (执行面自决退出)', () => {
  it('idle agents: consumes the request and exits 0 on the next poll', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    const requestFile = join(dshHome, 'restart-request')
    writeFileSync(requestFile, '')
    const interrupt = vi.fn()
    const record = vi.fn()
    const loop = fakeAgentLoop(() => false)
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => loop,
      interrupt,
      record,
      pollMs: 1_000,
      waitCapMs: 300_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    // First poll: consume + arm + no blocking work → exit on the same tick.
    vi.advanceTimersByTime(1_000)
    expect(interrupt).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledWith(0)
    expect(record).toHaveBeenCalledWith(expect.stringContaining('no blocking activity'))
    expect(loop.markDraining).toHaveBeenCalledOnce()
    expect(existsSync(join(dshHome, 'restart-pending'))).toBe(false) // cleared before exit
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('busy agent: waits for in-flight tools to settle, then exits 0', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    writeFileSync(join(dshHome, 'restart-request'), '')
    const interrupt = vi.fn()
    let busy = true
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => fakeAgentLoop(() => busy),
      interrupt,
      pollMs: 1_000,
      waitCapMs: 300_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    vi.advanceTimersByTime(1_000) // consume + arm
    expect(interrupt).not.toHaveBeenCalled()
    expect(existsSync(join(dshHome, 'restart-pending'))).toBe(true) // banner-visible state
    vi.advanceTimersByTime(5_000) // still busy
    expect(interrupt).not.toHaveBeenCalled()
    busy = false
    vi.advanceTimersByTime(1_000) // settles
    expect(interrupt).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledWith(0)
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('busy agent past the wait cap: drains now instead of waiting forever', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    writeFileSync(join(dshHome, 'restart-request'), '')
    const interrupt = vi.fn()
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => fakeAgentLoop(() => true),
      interrupt,
      pollMs: 1_000,
      waitCapMs: 3_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    vi.advanceTimersByTime(1_000) // consume + arm
    vi.advanceTimersByTime(3_000) // cap reached, still busy
    expect(interrupt).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledWith(0)
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('no agent loop (one-shot surface): exits immediately on request', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    writeFileSync(join(dshHome, 'restart-request'), '')
    const interrupt = vi.fn()
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => undefined,
      interrupt,
      pollMs: 1_000,
      waitCapMs: 300_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    vi.advanceTimersByTime(1_000)
    expect(interrupt).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledWith(0)
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('no request file: never interrupts', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    const interrupt = vi.fn()
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => fakeAgentLoop(() => true),
      interrupt,
      pollMs: 1_000,
      waitCapMs: 300_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    vi.advanceTimersByTime(30_000)
    expect(interrupt).not.toHaveBeenCalled()
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('stops firing once a shutdown has started', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    writeFileSync(join(dshHome, 'restart-request'), '')
    const interrupt = vi.fn()
    let shuttingDown = false
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => fakeAgentLoop(() => true),
      interrupt,
      isShuttingDown: () => shuttingDown,
      pollMs: 1_000,
      waitCapMs: 300_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    vi.advanceTimersByTime(1_000) // consume + arm
    shuttingDown = true
    vi.advanceTimersByTime(10_000)
    expect(interrupt).not.toHaveBeenCalled()
    rmSync(dshHome, { recursive: true, force: true })
  })
})

describe('restart coordinator immediate signal', () => {
  it('busy agent: touching restart-immediate drains on the next poll', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    writeFileSync(join(dshHome, 'restart-request'), '')
    const interrupt = vi.fn()
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => fakeAgentLoop(() => true),
      interrupt,
      pollMs: 1_000,
      waitCapMs: 300_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    vi.advanceTimersByTime(1_000) // consume + arm, still busy
    expect(interrupt).not.toHaveBeenCalled()
    writeFileSync(join(dshHome, 'restart-immediate'), '')
    vi.advanceTimersByTime(1_000)
    expect(interrupt).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledWith(0)
    // signal file cleaned up so it cannot leak into a later boot
    expect(existsSync(join(dshHome, 'restart-immediate'))).toBe(false)
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('stale immediate file without a request never fires (not armed)', () => {
    vi.useFakeTimers()
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    writeFileSync(join(dshHome, 'restart-immediate'), '')
    const interrupt = vi.fn()
    const stop = startRestartCoordinator({
      dshHome,
      getAgentLoop: () => fakeAgentLoop(() => true),
      interrupt,
      pollMs: 1_000,
      waitCapMs: 300_000,
    })
    timers.push(stop as unknown as ReturnType<typeof setInterval>)
    vi.advanceTimersByTime(5_000)
    expect(interrupt).not.toHaveBeenCalled()
    rmSync(dshHome, { recursive: true, force: true })
  })
})
