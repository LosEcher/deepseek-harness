#!/usr/bin/env node
/** Snapshot-only Loader driver: stream one fixture turn as canonical JSONL. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { installFailLoud } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from './production-profile.ts'

const NAME = 'headless-test-driver'
const REQUIRED_ENTRY_ENV = 'DSH_LOADER_SMOKE_REQUIRED_ENTRY_ID'
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0 || taskParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <task...>`)
}

/**
 * Load the fixture-local optional `.env`. One directory only, and only this driver needs it:
 * keeping it here is why the production `app-boot` no longer exports a generic `loadEnv`.
 * A missing file relies on the ambient environment; any other read error is reported.
 */
function loadFixtureEnv(dir: string = process.cwd()): void {
  try {
    process.loadEnvFile(resolve(dir, '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      process.stderr.write(`${NAME}: failed to load .env: ${String(error)}\n`)
    }
  }
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadFixtureEnv()
  ctx = await bootProductionProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [resolve(configPath)],
  })
  const requiredEntryId = process.env[REQUIRED_ENTRY_ENV]
  if (requiredEntryId !== undefined) {
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === requiredEntryId)
    if (entry === undefined) throw new Error(`${NAME}: required fixture entry not found: ${requiredEntryId}`)
    if (entry.fiber === undefined) throw new Error(`${NAME}: required fixture entry failed to import: ${requiredEntryId}`)
    await entry.fiber.await()
    if (entry.fiber.state !== FIBER_ACTIVE) {
      throw new Error(`${NAME}: required fixture entry did not activate: ${requiredEntryId}`)
    }
  }
  const result = await runFixtureTurn(ctx, {
    task: taskParts.join(' '),
    onEvent: (sessionId: string, event: SessionEvent) => {
      process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
    },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
