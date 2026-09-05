/** DSH one-shot subagent provider backed by LOS's bounded Grok runtime API. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'

export const name = 'subagent-los-grok'
export const inject = ['subagents']

export interface Config {
  providerName?: string
  baseUrl?: string
  authTokenEnv?: string
  operatorTokenEnv?: string
  timeoutMs?: number
  outputLimitBytes?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('los-grok'),
  baseUrl: z.string().min(1).default('http://127.0.0.1:8080'),
  authTokenEnv: z.string().min(1).default('LOS_AUTH_TOKEN'),
  operatorTokenEnv: z.string().min(1).default('LOS_OPERATOR_TOKEN'),
  timeoutMs: z.number().min(1_000).max(600_000).default(300_000),
  outputLimitBytes: z.number().min(4_096).max(512_000).default(128_000),
})

interface RuntimeEvent {
  readonly type: string
  readonly [key: string]: unknown
}

interface RuntimeResponse {
  readonly content: string
  readonly stopReason: 'completed' | 'aborted' | 'error'
  readonly diagnostic?: string
}

interface RuntimeClientOptions {
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function boundedText(value: string, limit: number): string {
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= limit) return value
  return decoder.decode(bytes.subarray(0, Math.max(0, limit - 24))) + '\n[output truncated]'
}

function eventText(event: RuntimeEvent): string {
  for (const key of ['content', 'output', 'text', 'summary']) {
    const value = event[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function parseEvent(block: string): RuntimeEvent | undefined {
  const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
  if (!data || data === '[DONE]') return undefined
  try {
    const value: unknown = JSON.parse(data)
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
      ? value as RuntimeEvent
      : undefined
  } catch {
    return undefined
  }
}

async function runLosGrok(
  request: ResolvedSubagentStartRequest,
  config: Required<Config>,
  options: RuntimeClientOptions = {},
): Promise<RuntimeResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const abort = () => controller.abort()
  request.signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, config.timeoutMs)
  try {
    const headers = { Authorization: `Bearer ${process.env[config.authTokenEnv] ?? ''}`, 'x-los-operator-token': process.env[config.operatorTokenEnv] ?? '' }
    const capabilities = await fetchImpl(`${config.baseUrl}/runtimes/capabilities`, { headers, signal: controller.signal })
    if (!capabilities.ok) return { content: '', stopReason: 'error', diagnostic: `LOS capability probe failed: HTTP ${capabilities.status}` }
    const capabilityBody = await capabilities.json() as {
      runtimes?: Array<{
        kind?: string
        implementation?: string
        available?: boolean
        unavailableReason?: string
      }>
    }
    const grok = capabilityBody.runtimes?.find(item => item.kind === 'grok')
    if (grok?.implementation !== 'runnable' || grok.available !== true) {
      return { content: '', stopReason: 'error', diagnostic: `LOS Grok unavailable: ${grok?.unavailableReason ?? 'capability_not_runnable'}` }
    }
    const response = await fetchImpl(`${config.baseUrl}/runtimes/grok/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n'), workspaceRoot: resolveChildCwd('subagent-los-grok', undefined, request.parent.session.header.cwd), timeoutMs: config.timeoutMs }),
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) return { content: '', stopReason: 'error', diagnostic: `LOS Grok invocation failed: HTTP ${response.status}` }
    const reader = response.body.getReader()
    let buffer = ''
    let content = ''
    let terminal: RuntimeEvent | undefined
    while (true) {
      const part = await reader.read()
      if (part.done) break
      buffer += decoder.decode(part.value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const event = parseEvent(block)
        if (event === undefined) continue
        if (event.type === 'runtime.output') content += eventText(event)
        if (event.type === 'runtime.completed' || event.type === 'runtime.error' || event.type === 'runtime.cancelled') terminal = event
      }
    }
    const finalEvent = parseEvent(buffer)
    if (finalEvent !== undefined) {
      if (finalEvent.type === 'runtime.output') content += eventText(finalEvent)
      if (finalEvent.type === 'runtime.completed' || finalEvent.type === 'runtime.error' || finalEvent.type === 'runtime.cancelled') terminal = finalEvent
    }
    if (request.signal.aborted || controller.signal.aborted) return { content, stopReason: 'aborted' }
    if (terminal?.type === 'runtime.cancelled') return { content, stopReason: 'aborted' }
    if (terminal?.type !== 'runtime.completed' || terminal.error !== undefined || terminal.exitCode !== 0) {
      return { content, stopReason: 'error', diagnostic: `LOS Grok runtime did not complete successfully (terminal=${terminal?.type ?? 'missing'}, exitCode=${String(terminal?.exitCode ?? 'missing')})${terminal?.error === undefined ? '' : `: ${String(terminal.error)}`}` }
    }
    return { content: boundedText(content, config.outputLimitBytes), stopReason: 'completed' }
  } catch (error: unknown) {
    if (request.signal.aborted || controller.signal.aborted) return { content: '', stopReason: 'aborted' }
    return { content: '', stopReason: 'error', diagnostic: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abort)
  }
}

class LosGrokProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  constructor(readonly name: string, private readonly config: Required<Config>) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const result = runLosGrok(request, this.config)
    return {
      id: SessionId(`los-grok:${request.descriptor.provider}:${Date.now()}`),
      localAgent: undefined,
      result: result.then((outcome): { output: ContentBlock[]; stopReason: 'completed' | 'aborted' | 'error'; diagnostic?: string } => ({
        output: outcome.content === '' ? [] : [{ type: 'text', text: outcome.content }],
        stopReason: outcome.stopReason,
        ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
      })),
      async dispose() {},
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = {
    providerName: config.providerName ?? 'los-grok',
    baseUrl: (config.baseUrl ?? 'http://127.0.0.1:8080').replace(/\/$/, ''),
    authTokenEnv: config.authTokenEnv ?? 'LOS_AUTH_TOKEN',
    operatorTokenEnv: config.operatorTokenEnv ?? 'LOS_OPERATOR_TOKEN',
    timeoutMs: config.timeoutMs ?? 300_000,
    outputLimitBytes: config.outputLimitBytes ?? 128_000,
  }
  if (!Number.isInteger(resolved.timeoutMs) || resolved.timeoutMs < 1_000 || resolved.timeoutMs > 600_000) throw new Error('subagent-los-grok: timeoutMs must be an integer between 1000 and 600000')
  if (!Number.isInteger(resolved.outputLimitBytes) || resolved.outputLimitBytes < 4_096 || resolved.outputLimitBytes > 512_000) throw new Error('subagent-los-grok: outputLimitBytes must be an integer between 4096 and 512000')
  ctx.subagents.registerProvider(new LosGrokProvider(resolved.providerName, resolved))
}

export { runLosGrok }
