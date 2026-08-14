/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/**
 * Default grace for draining one live agent to a clean turn boundary on
 * supervisor/factory teardown: the in-flight turn (model request and its tool
 * calls) runs to completion and `turn/end` persists as completed, so a
 * graceful restart resumes with no interrupted turn. Owner-triggered closes
 * (explicit session close) skip the wait.
 */
export const DEFAULT_AGENT_DRAIN_GRACE_MS = 30_000
