/**
 * LOS Grok HTTP runtime client and one-shot run publication.
 *
 * @module @deepseek-ai/dsh-subagent-los-grok
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

/** Resolved plugin config after schemastery defaults. */
export interface LosGrokRuntimeConfig {
  /** Provider registry name on `ctx.subagents`. */
  readonly providerName: string
  /** Base URL of the LOS gateway, without a trailing slash. */
  readonly baseUrl: string
  /** Environment variable containing the LOS auth token. */
  readonly authTokenEnv: string
  /** Environment variable containing the LOS operator token. */
  readonly operatorTokenEnv: string
  /** Maximum duration of one external runtime request in milliseconds. */
  readonly timeoutMs: number
  /** Maximum captured runtime output in bytes. */
  readonly outputLimitBytes: number
}

interface RuntimeEvent {
  readonly type: string
  readonly [key: string]: unknown
}

/** Terminal mapping of one LOS Grok invocation. */
export interface RuntimeResponse {
  readonly content: string
  readonly stopReason: 'completed' | 'aborted' | 'error'
  readonly diagnostic?: string
}

/** Optional test seams for {@link runLosGrok}. */
export interface RuntimeClientOptions {
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

function textPrompt(request: ResolvedSubagentStartRequest): string {
  return request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/**
 * Invoke LOS capability discovery and the bounded Grok SSE runtime.
 * @param request - the published one-shot start request.
 * @param config - load-resolved runtime settings.
 * @param options - optional fetch and abort seams for tests.
 * @returns the captured output and terminal stop reason.
 */
export async function runLosGrok(
  request: ResolvedSubagentStartRequest,
  config: LosGrokRuntimeConfig,
  options: RuntimeClientOptions = {},
): Promise<RuntimeResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const abort = () => controller.abort()
  const requestSignal = options.signal ?? request.signal
  if (requestSignal.aborted) return { content: '', stopReason: 'aborted' }
  requestSignal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, config.timeoutMs)
  try {
    const headers = {
      Authorization: `Bearer ${process.env[config.authTokenEnv] ?? ''}`,
      'x-los-operator-token': process.env[config.operatorTokenEnv] ?? '',
    }
    const capabilities = await fetchImpl(`${config.baseUrl}/runtimes/capabilities`, {
      headers,
      signal: controller.signal,
    })
    if (!capabilities.ok) {
      return { content: '', stopReason: 'error', diagnostic: `LOS capability probe failed: HTTP ${capabilities.status}` }
    }
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
      return {
        content: '',
        stopReason: 'error',
        diagnostic: `LOS Grok unavailable: ${grok?.unavailableReason ?? 'capability_not_runnable'}`,
      }
    }
    const workspaceRoot = resolveChildCwd(
      'subagent-los-grok',
      undefined,
      request.parent.session.header.cwd,
    )
    const response = await fetchImpl(`${config.baseUrl}/runtimes/grok/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: textPrompt(request),
        workspaceRoot,
        timeoutMs: config.timeoutMs,
      }),
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) {
      return { content: '', stopReason: 'error', diagnostic: `LOS Grok invocation failed: HTTP ${response.status}` }
    }
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
        if (event.type === 'runtime.completed' || event.type === 'runtime.error' || event.type === 'runtime.cancelled') {
          terminal = event
        }
      }
    }
    const finalEvent = parseEvent(buffer)
    if (finalEvent !== undefined) {
      if (finalEvent.type === 'runtime.output') content += eventText(finalEvent)
      if (
        finalEvent.type === 'runtime.completed'
        || finalEvent.type === 'runtime.error'
        || finalEvent.type === 'runtime.cancelled'
      ) {
        terminal = finalEvent
      }
    }
    if (requestSignal.aborted || controller.signal.aborted) return { content, stopReason: 'aborted' }
    if (terminal?.type === 'runtime.cancelled') return { content, stopReason: 'aborted' }
    if (terminal?.type !== 'runtime.completed' || terminal.error !== undefined || terminal.exitCode !== 0) {
      return {
        content,
        stopReason: 'error',
        diagnostic: `LOS Grok runtime did not complete successfully (terminal=${terminal?.type ?? 'missing'}, exitCode=${String(terminal?.exitCode ?? 'missing')})${terminal?.error === undefined ? '' : `: ${String(terminal.error)}`}`,
      }
    }
    return { content: boundedText(content, config.outputLimitBytes), stopReason: 'completed' }
  } catch (error: unknown) {
    if (requestSignal.aborted || controller.signal.aborted) return { content: '', stopReason: 'aborted' }
    return { content: '', stopReason: 'error', diagnostic: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    requestSignal.removeEventListener('abort', abort)
  }
}

function outputBlocks(content: string): ContentBlock[] {
  return content === '' ? [] : [{ type: 'text', text: content }]
}

/**
 * Publish a one-shot LOS Grok run. The HTTP work settles on {@link SubagentRun.result}.
 * @param request - the service-resolved start request.
 * @param config - load-resolved runtime settings.
 * @param options - optional fetch seam and failure sink.
 * @returns the published remote run handle.
 */
export function startLosGrokRun(
  request: ResolvedSubagentStartRequest,
  config: LosGrokRuntimeConfig,
  options: {
    fetchImpl?: typeof fetch
    onError?: (error: Error, stopReason: SubagentStopReason) => void
  } = {},
): SubagentRun {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  request.signal.addEventListener('abort', onAbort, { once: true })
  let cancelled = false
  let captured: RuntimeResponse = { content: '', stopReason: 'error' }
  const result = settleRunResult({
    attempt: async () => {
      captured = await runLosGrok(request, config, {
        ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
        signal: controller.signal,
      })
      return {
        output: outputBlocks(captured.content),
        stopReason: captured.stopReason,
        ...captured.diagnostic === undefined ? {} : { diagnostic: captured.diagnostic },
      }
    },
    collectOutput: () => outputBlocks(captured.content),
    collectDiagnostic: () => captured.diagnostic,
    cancelled: () => cancelled || request.signal.aborted || controller.signal.aborted,
    ...options.onError === undefined ? {} : { onError: options.onError },
    signal: request.signal,
    onAbort,
  })
  return subprocessRunHandle({
    id: SessionId(`los-grok:${request.descriptor.provider}:${randomUUID()}`),
    result,
    signal: request.signal,
    onAbort,
    requestCancel: () => {
      cancelled = true
      controller.abort()
    },
    teardown: async () => {
      controller.abort()
    },
  })
}
