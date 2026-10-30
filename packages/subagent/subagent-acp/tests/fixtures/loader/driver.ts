#!/usr/bin/env node
/** Test driver: one delegation turn through a headless Loader composition. */

import { resolve } from 'node:path'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('acp-subagent cwd driver requires a config path')

const ctx = await bootProductionProfile({
  binName: 'acp-subagent-cwd-e2e',
  profile: 'headless',
  overlayPaths: [resolve(configPath)],
})
try {
  const result = await runFixtureTurn(ctx, { task: 'delegate' })
  const parent = ctx.agents.roots().find(agent => agent.id === result.sessionId)
  if (parent === undefined) throw new Error('delegating parent is unavailable')
  await ctx.subagents.waitForChildren(parent)
  await parent.whenIdle()
  await ctx.sessions.flush(parent.session)
} finally {
  await ctx.fiber.dispose()
}
