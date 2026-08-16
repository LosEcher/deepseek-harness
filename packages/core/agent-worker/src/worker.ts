/**
 * One-Agent worker process. Speaks the product bridge on stdin/stdout.
 * @module @deepseek-ai/dsh-agent-worker
 */

import { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  admitAgentWorkerFrame,
  AgentControlError,
  assertCanAcquire,
  fixtureErrorText,
  type AgentControlCreateOptions,
  type AgentControlMessage,
  type AgentControlResumeOptions,
  type AgentDescriptor,
} from '@deepseek-ai/dsh-agent-control'
import {
  encodeFrame,
  FrameDecoder,
  isPriorityFrame,
  PROTOCOL_VERSION,
  validatePeerHello,
  type BridgeMessage,
  type Hello,
} from '@deepseek-ai/dsh-bridge-protocol'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentCancelCause } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
// Type-only: carries the `ctx.typertGateway` Context merge into this program.
import type {} from '@deepseek-ai/dsh-api-gateway'
import { toUserMessage } from './messages.ts'

class FixtureAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const digest = process.env.DSH_AGENT_WORKER_DIGEST ?? ''
const build = process.env.DSH_AGENT_WORKER_BUILD ?? 'agent-worker'
const eventCredit = Number.parseInt(process.env.DSH_AGENT_WORKER_EVENT_CREDIT ?? '64', 10)
const sessionRoot = process.env.DSH_AGENT_WORKER_SESSION_ROOT
/**
 * Optional composed-profile name. When set, the worker boots the FULL profile
 * composition (real LLM adapters, tools, credentials, presets) instead of the
 * fixture spine — the product-composition mode that headless-style Agent
 * isolation requires. Resolved through the standard profile loader
 * (`loadProfile`), so the worker sees exactly the bundle + user layers the
 * host composes for that profile name. Prefer an execution-surface profile
 * (headless): a control-surface profile (web) mounts listeners and ports.
 */
const profileName = process.env.DSH_AGENT_WORKER_PROFILE
/** Profile-mode boot diagnostics on stderr; off unless explicitly requested. */
const profileDebug = process.env.DSH_AGENT_WORKER_DEBUG === '1'

let generation = 0
let remainingCredit = Number.isInteger(eventCredit) ? eventCredit : 64
let ctx: Context | undefined
let handle: AgentHandle | undefined
let descriptor: AgentDescriptor | undefined
let owner = 'host'
const pendingEvents: BridgeMessage[] = []

const decoder = new FrameDecoder()

function send(message: BridgeMessage): void {
  process.stdout.write(encodeFrame(message))
}

function reply(id: string, result: unknown): void {
  send({ kind: 'reply', payload: { generation, id, result } })
}

function reject(id: string, error: AgentControlError): void {
  send({
    kind: 'error',
    payload: {
      generation,
      id,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.code === 'busy',
        cancelled: false,
      },
    },
  })
}

/**
 * The empty profile root the worker keeps canonical in the profile directory,
 * mirroring `apps/cli/src/profile-boot.ts` `PROFILE_ROOT_CONFIG` (that file is
 * the source of truth — keep the literal in sync). The vendored Loader's tree
 * write-back can bake composed rows into this file, which would duplicate
 * every bundle insert on the next boot.
 */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

let failLoudInstalled = false

/**
 * Boot the full profile composition for {@link profileName} exactly as a host
 * surface would: resolve bundle layers and the user patch layers through the
 * standard profile loader, mount them over the profile's empty root config,
 * and audit the loaded tree. Imports are dynamic so the fixture spine (the
 * protocol-test default) never pays for the app-boot module graph.
 */
async function bootProfile(name: string): Promise<Context> {
  // Only the app-boot module graph stays dynamic: the fixture spine (the
  // protocol-test default) never pays for it.
  const { boot, createConsoleLoggerExporter, healProfilesModuleFallback, installFailLoud, loadOptionalPatches, loadProfile } = await import('@deepseek-ai/dsh-app-boot')
  const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths')
  if (profileDebug) process.stderr.write(`[worker] profile mode: ${name}\n`)
  // A worker is a long-lived service process: an unhandled rejection must
  // surface on stderr and exit non-zero (the supervisor observes the child),
  // not hang the generation silently.
  if (!failLoudInstalled) {
    failLoudInstalled = true
    installFailLoud('agent-worker')
  }
  // Anchor at this package's own package.json — the CLI launcher's
  // INSTALL_ANCHOR convention — so profile bundles resolve from the worker
  // installation first, then the profile directory's node_modules.
  const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
  healProfilesModuleFallback(installAnchor)
  const profile = loadProfile('agent-worker', name, installAnchor, resolveDshHome())
  // Mirror the CLI's prepareProfile: keep the empty root config canonical
  // before composing over it (see PROFILE_ROOT_CONFIG).
  writeFileSync(join(profile.dir, 'cordis.yml'), PROFILE_ROOT_CONFIG)
  // The CLI composes bundle layers, the profile's user layer, then the
  // home-level user layer (`$DSH_HOME/cordis.patch.yml`) in that order. The
  // worker mirrors the same stack (no --patch overlays, no telemetry switch).
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOptionalPatches('agent-worker', join(resolveDshHome(), 'cordis.patch.yml')) ?? [],
  ])
  if (profileDebug) process.stderr.write(`[worker] booting ${join(profile.dir, 'cordis.yml')} patches=${patches.length}\n`)
  // Service-process boot: entry-point rows that stay pending (task drivers
  // whose cmdline service this composition does not mount) are fine; failed
  // loads still fail loud through the loaded-only audit. The product bridge
  // owns stdout, so the composed tree logs through the stderr exporter from
  // the first mounted row (a single stdout log line would corrupt the frame
  // stream).
  const result = await boot(
    'agent-worker',
    join(profile.dir, 'cordis.yml'),
    patches,
    undefined,
    undefined,
    false,
    createConsoleLoggerExporter({ stderr: true }),
  )
  if (profileDebug) process.stderr.write('[worker] boot ok\n')
  return result
}

async function boot(): Promise<Context> {
  // Product-composition mode: mount the real profile tree (adapters, tools,
  // credentials, presets) exactly as the host would. The fixture spine below
  // remains the default for protocol tests — the P1 boundary keeps assembled
  // product snapshots on the in-process path until a profile mounts here.
  if (profileName !== undefined) return bootProfile(profileName)
  const next = new Context()
  await next.plugin(LlmRuntime)
  await next.plugin(SessionStore)
  await next.plugin(SystemPrompt)
  await next.plugin(ToolRuntime)
  await next.plugin(AgentRegistry)
  await next.plugin(AgentLoop, { agents: [] })
  if (sessionRoot !== undefined) {
    await next.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
  }
  next.llm.registerAdapter(['mock'], new FixtureAdapter())
  return next
}

function emitSessionEvent(seq: number, event: unknown): void {
  const frame: BridgeMessage = {
    kind: 'event_invoke',
    payload: {
      generation,
      id: `evt-${seq}`,
      event: 'session/event',
      payload: { seq, event },
      dispatch: 'emit',
    },
  }
  if (remainingCredit <= 0) {
    pendingEvents.push(frame)
    return
  }
  remainingCredit -= 1
  send(frame)
}

/**
 * Dispatch one Host Remote invocation inside this worker's composition.
 * @param id - the request id to reply on.
 * @param method - the host-service method (`invoke`).
 * @param body - wire args `{ namespace, method, args }`.
 */
async function handleHostInvoke(id: string, method: string, body: Record<string, unknown>): Promise<void> {
  if (ctx === undefined) throw new AgentControlError('unknown-agent', 'unknown agent')
  if (method === 'invoke') {
    const gateway = ctx.get('typertGateway')
    if (gateway === undefined) {
      throw new AgentControlError('unknown-service', 'host gateway is not mounted in this composition')
    }
    const namespace = typeof body.namespace === 'string' ? body.namespace : ''
    const target = typeof body.method === 'string' ? body.method : ''
    const args = isRecord(body.args) ? body.args : {}
    const result = await gateway.invoke({ namespace, method: target, args })
    reply(id, result)
    return
  }
  if (method === 'apiProxy') {
    // Direct ApiProxy dispatch: the worker-web composition mounts ctx.apiProxy
    // (api-proxy ④), and Host clients call its sections through the bridge.
    const api = ctx.get('apiProxy')
    if (api === undefined) {
      throw new AgentControlError('unknown-service', 'api proxy is not mounted in this composition')
    }
    const section = typeof body.section === 'string' ? body.section : ''
    const target = typeof body.method === 'string' ? body.method : ''
    const args: unknown[] = Array.isArray(body.args) ? [...(body.args as unknown[])] : []
    const sectionApi = (api as unknown as Record<string, unknown>)[section]
    if (!isRecord(sectionApi) || typeof sectionApi[target] !== 'function') {
      throw new AgentControlError('unknown-service', `unknown api-proxy method ${section}/${target}`)
    }
    const result = await (sectionApi[target] as (...call: unknown[]) => unknown)(...args)
    reply(id, result)
    return
  }
  throw new AgentControlError('unknown-service', fixtureErrorText('unknown-service'))
}

async function handleCall(message: Extract<BridgeMessage, { kind: 'call' }>): Promise<void> {
  try {
    admitAgentWorkerFrame(message, generation)
    const { id, method, args, service } = message.payload
    const body = isRecord(args) ? args : {}
    // Host service: dispatch Remote invocations into this worker's own
    // composition (the worker-local Host surface — api-proxy ④). The typert
    // gateway resolves the method from this composition's descriptor catalog.
    if (service === 'host') {
      await handleHostInvoke(id, method, body)
      return
    }
    if (method === 'create') {
      if (handle !== undefined) throw new AgentControlError('already-held', fixtureErrorText('already-held'))
      ctx = await boot()
      const options = body.options as AgentControlCreateOptions
      owner = typeof body.owner === 'string' ? body.owner : 'host'
      handle = await ctx.agents.create({
        sessionId: SessionId(String(options.sessionId)),
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
      })
      bindAgent(handle.agent)
      assertCanAcquire(handle.agent.session.events, generation)
      handle.agent.session.append('session/ownership', {
        generation,
        action: 'acquire',
        backend: 'worker-ts',
        owner,
      })
      descriptor = {
        id: handle.agent.id,
        generation,
        backend: 'worker-ts',
        status: handle.agent.status,
        phase: 'ready',
        configDigest: digest,
      }
      reply(id, descriptor)
      return
    }
    if (method === 'resume') {
      if (handle !== undefined) throw new AgentControlError('already-held', fixtureErrorText('already-held'))
      ctx = await boot()
      const options = body.options as AgentControlResumeOptions
      owner = typeof body.owner === 'string' ? body.owner : 'host'
      handle = await ctx.agents.resume({
        resumeSessionId: SessionId(String(options.resumeSessionId)),
        ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions },
      })
      bindAgent(handle.agent)
      assertCanAcquire(handle.agent.session.events, generation)
      handle.agent.session.append('session/ownership', {
        generation,
        action: 'acquire',
        backend: 'worker-ts',
        owner,
      })
      descriptor = {
        id: handle.agent.id,
        generation,
        backend: 'worker-ts',
        status: handle.agent.status,
        phase: 'ready',
        configDigest: digest,
      }
      reply(id, descriptor)
      return
    }
    if (handle === undefined || descriptor === undefined) {
      throw new AgentControlError('unknown-agent', 'unknown agent')
    }
    if (method === 'send') {
      handle.agent.send(
        toUserMessage(body.message as AgentControlMessage),
        body.target === 'next-step' ? 'next-step' : 'next-turn',
        body.wakeup === true,
      )
      reply(id, null)
      return
    }
    if (method === 'followup') {
      handle.agent.followup(toUserMessage(body.message as AgentControlMessage))
      reply(id, null)
      return
    }
    if (method === 'steer') {
      handle.agent.steer(toUserMessage(body.message as AgentControlMessage))
      reply(id, null)
      return
    }
    if (method === 'inject') {
      handle.agent.inject(toUserMessage(body.message as AgentControlMessage))
      reply(id, null)
      return
    }
    if (method === 'cancel') {
      handle.agent.cancel(body.cause as AgentCancelCause, body.keepInbox === true ? { keepInbox: true } : undefined)
      reply(id, null)
      return
    }
    if (method === 'whenIdle') {
      await handle.agent.whenIdle()
      reply(id, null)
      return
    }
    if (method === 'flush') {
      if (ctx === undefined) throw new AgentControlError('unknown-agent', 'unknown agent')
      await ctx.sessions.flush(handle.agent.session)
      reply(id, null)
      return
    }
    if (method === 'drain') {
      await handle.agent.whenIdle()
      if (ctx !== undefined) await ctx.sessions.flush(handle.agent.session)
      handle.agent.session.append('session/ownership', {
        generation,
        action: 'release',
        backend: 'worker-ts',
        owner,
      })
      if (ctx !== undefined) await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
      handle = undefined
      descriptor = { ...descriptor, phase: 'drained', status: 'idle' }
      send({
        kind: 'event_invoke',
        payload: {
          generation,
          id: 'drained',
          event: 'agent/drained',
          payload: { agent: descriptor.id, generation },
          dispatch: 'emit',
        },
      })
      reply(id, null)
      return
    }
    if (method === 'get') {
      reply(id, descriptor)
      return
    }
    if (method === 'list' || method === 'roots') {
      reply(id, [descriptor])
      return
    }
    if (method === 'isOwnedBy') {
      reply(id, body.owner === owner)
      return
    }
    throw new AgentControlError('unknown-service', fixtureErrorText('unknown-service'))
  } catch (error) {
    const failure = error instanceof AgentControlError
      ? error
      : new AgentControlError('fault', error instanceof Error ? error.message : String(error))
    reject(message.payload.id, failure)
  }
}

function bindAgent(agent: Agent): void {
  agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    emitSessionEvent(event.seq, event)
  })
  agent.ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return
    if (descriptor !== undefined) descriptor = { ...descriptor, status }
    send({
      kind: 'event_invoke',
      payload: {
        generation,
        id: `status-${status}`,
        event: 'agent/status',
        payload: { agent: agent.id, status },
        dispatch: 'emit',
      },
    })
  })
}

function handleMessage(message: BridgeMessage): void {
  if (message.kind === 'hello') {
    generation = message.payload.generation
    const local: Hello = {
      bridge_version: PROTOCOL_VERSION,
      generation,
      role: 'node_worker',
      build,
      schema_digest: digest,
      capabilities: ['agent-worker'],
    }
    validatePeerHello(local, message.payload, digest)
    send({ kind: 'hello', payload: local })
    send({
      kind: 'contribution_register',
      payload: { generation, id: 'agent-worker', plugin: 'agent-worker', service: 'agent' },
    })
    return
  }
  if (message.kind === 'stream_credit') {
    remainingCredit += message.payload.credit_bytes
    while (remainingCredit > 0 && pendingEvents.length > 0) {
      const next = pendingEvents.shift()
      if (next === undefined) break
      remainingCredit -= 1
      send(next)
    }
    return
  }
  if (message.kind === 'dispose') {
    send({ kind: 'quiescent', payload: { generation } })
    process.exit(0)
  }
  if (message.kind === 'call') {
    void handleCall(message)
    return
  }
  if (message.kind === 'cancel' && handle !== undefined) {
    handle.agent.cancel({ kind: 'user' })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

process.stdin.on('data', (chunk: Buffer) => {
  const messages = decoder.push(chunk)
  const ordered = [
    ...messages.filter(isPriorityFrame),
    ...messages.filter(message => !isPriorityFrame(message)),
  ]
  for (const message of ordered) handleMessage(message)
})
process.stdin.resume()
