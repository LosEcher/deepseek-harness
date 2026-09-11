/**
 * Optional one-shot subagent provider backed by LOS's bounded Grok runtime API.
 * Named exports only; a default would hide loader metadata.
 *
 * @module @deepseek-ai/dsh-subagent-los-grok
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { startLosGrokRun, type LosGrokRuntimeConfig } from './run.ts'

export const name = 'subagent-los-grok'
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'los-grok'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'
const DEFAULT_AUTH_TOKEN_ENV = 'LOS_AUTH_TOKEN'
const DEFAULT_OPERATOR_TOKEN_ENV = 'LOS_OPERATOR_TOKEN'
const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 128_000

/** Deployment-owned LOS gateway, credential, timeout, and output bounds. */
export interface Config {
  /** Provider registry name on `ctx.subagents` (default `los-grok`). */
  providerName?: string
  /** Base URL of the LOS gateway (default `http://127.0.0.1:8080`). */
  baseUrl?: string
  /** Environment variable containing the LOS auth token (default `LOS_AUTH_TOKEN`). */
  authTokenEnv?: string
  /** Environment variable containing the LOS operator token (default `LOS_OPERATOR_TOKEN`). */
  operatorTokenEnv?: string
  /** Maximum duration of one external runtime request in milliseconds (default `300000`). */
  timeoutMs?: number
  /** Maximum captured runtime output in bytes (default `128000`). */
  outputLimitBytes?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  baseUrl: z.string().min(1).default(DEFAULT_BASE_URL),
  authTokenEnv: z.string().min(1).default(DEFAULT_AUTH_TOKEN_ENV),
  operatorTokenEnv: z.string().min(1).default(DEFAULT_OPERATOR_TOKEN_ENV),
  timeoutMs: z.number().step(1).min(1_000).max(600_000).default(DEFAULT_TIMEOUT_MS),
  outputLimitBytes: z.number().step(1).min(4_096).max(512_000).default(DEFAULT_OUTPUT_LIMIT_BYTES),
})

class LosGrokProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: LosGrokRuntimeConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('subagent-los-grok: request was aborted before the runtime call')
    }
    try {
      resolveChildCwd('subagent-los-grok', undefined, request.parent.session.header.cwd)
    } catch (error: unknown) {
      this.ctx.logger.warn(`subagent-los-grok "${this.name}": child start failed: %o`, error)
      throw error
    }
    return startLosGrokRun(request, this.config, {
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-los-grok "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    })
  }
}

/**
 * Register one Profile-named LOS Grok provider.
 * @param ctx - context carrying the shared subagent registry.
 * @param config - registry name, LOS gateway, credential env names, timeout, and output bound.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: LosGrokRuntimeConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    authTokenEnv: config.authTokenEnv ?? DEFAULT_AUTH_TOKEN_ENV,
    operatorTokenEnv: config.operatorTokenEnv ?? DEFAULT_OPERATOR_TOKEN_ENV,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputLimitBytes: config.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
  }
  ctx.subagents.registerProvider(new LosGrokProvider(resolved.providerName, ctx, resolved))
}

export { runLosGrok, startLosGrokRun } from './run.ts'
