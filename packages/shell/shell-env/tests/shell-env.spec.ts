/**
 * Registry tests for `@deepseek-ai/dsh-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { DshEnvironmentKey } from '@deepseek-ai/dsh-shell'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: ToolCallId('bash-env-call'),
    rootCallId: ToolCallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : {
        agent: {
          session: {
            header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false },
          },
        } as unknown as Agent,
      }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })

    expect(registry.collect(execution())).toEqual({
      DSH_HOME: resolve('./test-dsh-home'),
      DSH_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      DSH_HOME: resolve('./test-dsh-home'),
      DSH_SESSION_ID: 'session-a',
      DSH_SHELL: '1',
    })
  })

  it('collects the launcher-provided profile name and directory when a profile context exists', () => {
    const ctx = new Context()
    ctx.provide('profileContext', {
      name: 'web', dir: '/profiles/web', patchPath: '/profiles/web/cordis.patch.yml', installAnchor: '/dsh/package.json',
      cwd: '/work', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    })
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    expect(registry.collect(execution())).toMatchObject({ DSH_PROFILE: 'web', DSH_PROFILE_DIR: '/profiles/web' })
    expect(() => registry.register({
      name: 'profile-claimer',
      keys: ['DSH_PROFILE'],
      resolve: () => ({}),
    })).toThrow(/reserved key "DSH_PROFILE"/)
  })

  it('resolves DSH_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('DSH_HOME', './ambient-dsh-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).DSH_HOME).toBe(resolve('./ambient-dsh-home'))

    vi.stubEnv('DSH_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).DSH_HOME).toBe(join(homedir(), '.dsh'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'optional-session-fact',
      keys: ['DSH_SESSION_OPTIONAL'],
      resolve: exec => exec.agent === undefined ? {} : { DSH_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      keys: ['DSH_ALWAYS_AVAILABLE'],
      resolve: () => ({ DSH_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('DSH_SESSION_OPTIONAL')
    expect(registry.collect(execution()).DSH_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).DSH_SESSION_OPTIONAL).toBe('session-b')
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'first',
      keys: ['DSH_SHARED'],
      resolve: () => ({ DSH_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      keys: ['DSH_SHARED'],
      resolve: () => ({ DSH_SHARED: 'second' }),
    })).toThrow(/DSH_SHARED.*first.*second|DSH_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    registry.register({
      name: 'declared',
      keys: ['DSH_DECLARED'],
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      keys: ['DSH_ANOTHER'],
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      keys: ['DSH_BLANK_NAME'],
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      keys: ['dsh_invalid'] as unknown as readonly DshEnvironmentKey[],
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      keys: ['DSH_HOME'],
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'duplicate-declaration',
      keys: ['DSH_REPEATED', 'DSH_REPEATED'],
      resolve: () => ({}),
    })).toThrow(/declared key "DSH_REPEATED" twice/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'drifted-provider',
      keys: ['DSH_DECLARED'],
      resolve: () => ({ DSH_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*DSH_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    registry.register({
      name: 'wrong-value-type',
      keys: ['DSH_STRING'],
      resolve: () => ({ DSH_STRING: 42 }) as unknown as Record<'DSH_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*DSH_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          keys: ['DSH_TEMPORARY'],
          resolve: () => ({ DSH_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).DSH_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('DSH_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      keys: ['DSH_EXPLICIT_DISPOSAL'],
      resolve: () => ({ DSH_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).DSH_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('DSH_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service with no contributors on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.collect(execution())).not.toHaveProperty('DSH_ALWAYS_AVAILABLE')
  })
})
