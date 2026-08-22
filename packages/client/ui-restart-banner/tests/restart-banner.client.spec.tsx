// @vitest-environment jsdom
/**
 * RestartBanner spec: renders nothing while no restart is armed, renders the
 * title/body with the cap-derived seconds while armed, and hides again when
 * the window clears.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/src/client/contract/store.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Side-effect import: pulls the client entry's LocaleNamespaceMap augmentation
// into this test program (module augmentations apply per program, not per file).
import '../src/client/index.ts'
import { RestartBanner, type RestartBannerProps } from '../src/client/RestartBanner.tsx'
import { zh } from '../src/client/locales.ts'
import type { HostStatusRuntime } from '@deepseek-ai/dsh-client-runtime/client'

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t: RestartBannerProps['t'] = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
})

/** A host-status face with a scripted snapshot store (no polling). */
function fakeHostStatus(
  state: Parameters<HostStatusRuntime['status']['set']>[0],
  requestRestartImmediate = (): Promise<boolean> => Promise.resolve(true),
) {
  const store = createSnapshotStore(state)
  return { status: store, requestRestartImmediate } as unknown as HostStatusRuntime
}

describe('RestartBanner', () => {
  it('renders nothing while no restart is armed and no exit trace is fresh', () => {
    const { container } = render(
      <RestartBanner
        hostStatus={fakeHostStatus({ restartPending: undefined, restartExited: undefined, reachable: true })}
        t={t}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the banner with the cap-derived wait bound while armed', () => {
    render(
      <RestartBanner
        hostStatus={fakeHostStatus({
          restartPending: { sinceMs: Date.now() - 3_000, capMs: 30_000 },
          restartExited: undefined,
          reachable: true,
        })}
        t={t}
      />,
    )
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('DSH 正在重启…')).toBeTruthy()
    expect(screen.getByText(/已等待 \d+ 秒/)).toBeTruthy()
    expect(screen.getByText(/最多等待 30 秒/)).toBeTruthy()
  })

  it('renders a restart-now button while armed and calls the runtime on click (O7)', () => {
    const requestRestartImmediate = vi.fn(() => Promise.resolve(true))
    render(
      <RestartBanner
        hostStatus={fakeHostStatus(
          { restartPending: { sinceMs: Date.now(), capMs: 30_000 }, restartExited: undefined, reachable: true },
          requestRestartImmediate,
        )}
        t={t}
      />,
    )
    const button = screen.getByRole('button', { name: '立即重启' })
    button.click()
    expect(requestRestartImmediate).toHaveBeenCalledOnce()
  })

  it('renders a one-shot restart-completed notice while the exit trace is fresh', () => {
    render(
      <RestartBanner
        hostStatus={fakeHostStatus({
          restartPending: undefined,
          restartExited: { exitedAt: Date.now() - 1_000 },
          reachable: true,
        })}
        t={t}
      />,
    )
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('重启完成')).toBeTruthy()
    expect(screen.getByText(/自动续跑/)).toBeTruthy()
  })

  it('ignores a stale restart-exited trace', () => {
    render(
      <RestartBanner
        hostStatus={fakeHostStatus({
          restartPending: undefined,
          restartExited: { exitedAt: Date.now() - 120_000 },
          reachable: true,
        })}
        t={t}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('hides again when the restart window clears', () => {
    const ctx = new Context()
    const runtime = fakeHostStatus({ restartPending: { sinceMs: 0, capMs: 5_000 }, restartExited: undefined, reachable: true })
    const { rerender, container } = render(<RestartBanner hostStatus={runtime} t={t} />)
    expect(container.firstChild).not.toBeNull()
    ;(runtime.status as ReturnType<typeof createSnapshotStore>).set({
      restartPending: undefined,
      restartExited: undefined,
      reachable: true,
    })
    rerender(<RestartBanner hostStatus={runtime} t={t} />)
    expect(container.firstChild).toBeNull()
    void ctx
  })
})
