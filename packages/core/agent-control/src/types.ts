/**
 * Process-safe Agent control types. Live `Agent` objects never appear here.
 * @module @deepseek-ai/dsh-agent-control
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Explicit backend selected when a generation starts. */
export type AgentBackend = 'local-ts' | 'worker-ts'

/** Control-plane phase for one generation. Status stays idle/running separately. */
export type AgentControlPhase = 'ready' | 'drained' | 'faulted'

/** Descriptor the main process may hold; it is not a live Agent. */
export interface AgentDescriptor {
  /** Session/agent identity. */
  readonly id: SessionId
  /** Monotonic generation for this worker lifetime. */
  readonly generation: number
  /** Backend that holds the current generation. */
  readonly backend: AgentBackend
  /** Last mirrored idle/running status. */
  readonly status: 'idle' | 'running'
  /** Control-plane phase after ready, drain, or fault. */
  readonly phase: AgentControlPhase
  /** Digest of the composition this generation booted. */
  readonly configDigest: string
}

/** JSON-serializable user message accepted by control commands. */
export interface AgentControlMessage {
  /** Message identity. */
  readonly id: string
  /** Role as recorded on the wire. */
  readonly role: 'user'
  /** Model-visible content; must be lossless JSON. */
  readonly content: unknown
  /** Source attribution when the caller supplied one. */
  readonly source?: unknown
}

/** Create options that may cross the process boundary. */
export interface AgentControlCreateOptions {
  /** Live agent/session identity. */
  readonly sessionId: SessionId
  /** Explicit backend for this generation. */
  readonly backend?: AgentBackend
  /** Bounded replay window; omitted uses the service default. Zero is rejected. */
  readonly replayWindow?: number
  /** Session metadata forwarded to the worker-local factory. */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  /** Per-agent model route options. */
  readonly agentOptions?: {
    readonly provider?: string
    readonly model?: string
    readonly maxTokens?: number
  }
}

/** Resume options that may cross the process boundary. */
export interface AgentControlResumeOptions {
  /** Persisted session identity. */
  readonly resumeSessionId: SessionId
  /** Explicit backend for this generation. */
  readonly backend?: AgentBackend
  /** Bounded replay window; omitted uses the service default. Zero is rejected. */
  readonly replayWindow?: number
  /** Per-agent model route options. */
  readonly agentOptions?: {
    readonly provider?: string
    readonly model?: string
    readonly maxTokens?: number
  }
}

/** Event-stream ownership record written as `session/ownership`. */
export interface SessionOwnership {
  /** Generation that acquired or released the writer role. */
  readonly generation: number
  /** Acquire or release. */
  readonly action: 'acquire' | 'release'
  /** Backend that wrote the record. */
  readonly backend: AgentBackend
  /** Process-visible owner identity (role or pid). */
  readonly owner: string
}

/** Typed control-plane error codes. */
export type AgentControlErrorCode =
  | 'busy'
  | 'generation-retired'
  | 'already-held'
  | 'unknown-service'
  | 'functions-never-cross'
  | 'replay-unbounded'
  | 'unknown-agent'
  | 'fault'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The generation that currently may append to this session, or the
     * release that leaves the session without a writer. Required on read:
     * a log that carries this event cannot be interpreted by a writer that
     * does not understand ownership.
     */
    'session/ownership': SessionOwnership
  }
}
