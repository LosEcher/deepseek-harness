import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, TOOL_ABORTED_BEFORE_DISPATCH } from '../src/index.ts'
import { CallId } from '@deepseek-ai/dsh-llm'
import { DispatchDrain } from '../src/drain.ts'

const testSignal = new AbortController().signal

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('DispatchDrain', () => {
  it('is idle immediately when nothing is in flight and closes the gate', async () => {
    const drain = new DispatchDrain()
    expect(drain.accepting).toBe(true)
    expect(await drain.closeAndWait(100)).toBe(true)
    expect(drain.accepting).toBe(false)
  })

  it('waits for tracked executions to settle and reports idle', async () => {
    const drain = new DispatchDrain()
    const gate = deferred<string>()
    const work = drain.track(gate.promise)
    let result: boolean | undefined
    const waiting = drain.closeAndWait(1000).then((value) => { result = value })
    await Promise.resolve()
    expect(result).toBeUndefined()
    gate.resolve('done')
    await waiting
    expect(result).toBe(true)
    await expect(work).resolves.toBe('done')
  })

  it('times out when a tracked execution never settles', async () => {
    const drain = new DispatchDrain()
    drain.track(new Promise<void>(() => {}))
    expect(await drain.closeAndWait(50)).toBe(false)
  })

  it('drops settled executions from the tracked set', async () => {
    const drain = new DispatchDrain()
    drain.track(Promise.resolve(1))
    await Promise.resolve()
    expect(await drain.closeAndWait(100)).toBe(true)
  })
})

describe('ToolRuntime shutdown drain', () => {
  it('rejects new executions with the canonical abort result once closed', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'p', parameters: {},
      async execute() { return [] },
    }))
    await ctx.tools.shutdownDrain(100)
    const result = await ctx.tools.execute({ signal: testSignal, callId: CallId('drain-c1'), name: 'probe', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ code: TOOL_ABORTED_BEFORE_DISPATCH })
  })

  it('lets an in-flight execution finish before the drain reports idle', async () => {
    const ctx = await setup()
    const gate = deferred<string>()
    ctx.tools.register(defineContentToolFixture({
      name: 'slow', description: 's', parameters: {},
      async execute() { return [{ type: 'text', text: await gate.promise }] },
    }))
    const pending = ctx.tools.execute({ signal: testSignal, callId: CallId('drain-c2'), name: 'slow', arguments: {} })
    let idle: boolean | undefined
    const waiting = ctx.tools.shutdownDrain(1000).then((value) => { idle = value })
    await Promise.resolve()
    expect(idle).toBeUndefined()
    gate.resolve('settled')
    await waiting
    expect(idle).toBe(true)
    const result = await pending
    expect(result.isError).toBe(false)
  })
})
