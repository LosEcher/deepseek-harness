#!/usr/bin/env node
/** Test driver that sends two turns through one Headless Loader composition. */

import { resolve } from 'node:path'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('time-context driver requires a config path')

const ctx = await bootProductionProfile({
  binName: 'time-context-e2e',
  profile: 'headless',
  overlayPaths: [resolve(configPath)],
})
try {
  await runFixtureTurn(ctx, { task: 'first' })
  await runFixtureTurn(ctx, { task: 'second' })
} finally {
  await ctx.fiber.dispose()
}
