import { describe, expect, it, vi } from 'vitest'
import { resolveTelemetryPatch, warnModuleHmrRoots } from '../src/profile-boot.ts'

describe('resolveTelemetryPatch', () => {
  it('preserves the configured telemetry mode when the hard-disable switch is unset or empty', () => {
    expect(resolveTelemetryPatch(undefined, true)).toBeUndefined()
    expect(resolveTelemetryPatch('', true)).toBeUndefined()
  })

  it('disables on ANY non-empty value, including falsy-looking ones', () => {
    for (const value of ['1', '0', 'false', 'no']) {
      expect(resolveTelemetryPatch(value, true)).toEqual({ id: 'session-telemetry-otel', disabled: true })
    }
  })

  it('is trivially satisfied by a composition without the telemetry row', () => {
    // A custom profile need not mount telemetry: nothing exports, so the
    // privacy switch has nothing to disable and generates no patch.
    expect(resolveTelemetryPatch('1', false)).toBeUndefined()
    expect(resolveTelemetryPatch(undefined, false)).toBeUndefined()
  })
})

describe('warnModuleHmrRoots', () => {
  it('stays quiet for missing, disabled, or empty-root HMR rows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnModuleHmrRoots(undefined)
      warnModuleHmrRoots({ id: 'hmr', name: 'hmr', disabled: true, config: { root: ['/tmp/x'] } })
      warnModuleHmrRoots({ id: 'hmr', name: 'hmr', config: { root: [] } })
      warnModuleHmrRoots({ id: 'hmr', name: 'hmr', config: {} })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('warns once when module HMR watches non-empty source roots', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnModuleHmrRoots({ id: 'hmr', name: 'hmr', config: { root: ['/tmp/plugin'] } })
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]?.[0])).toContain('/tmp/plugin')
      expect(String(warn.mock.calls[0]?.[0])).toContain('module HMR')
    } finally {
      warn.mockRestore()
    }
  })
})
