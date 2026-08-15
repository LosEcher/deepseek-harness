/**
 * Reconstruct a live UserMessage from a control-plane payload.
 * @module @deepseek-ai/dsh-agent-worker
 */

import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { AgentControlMessage } from '@deepseek-ai/dsh-agent-control'

/**
 * Build a frozen UserMessage from a JSON-serializable control payload.
 * @param message - wire message admitted by the control service.
 * @returns a live UserMessage the worker-local Agent can consume.
 */
export function toUserMessage(message: AgentControlMessage): UserMessage {
  const created = createUserMessage({
    content: message.content as UserMessage['content'],
    source: (message.source ?? { kind: 'user' }) as UserMessage['source'],
  })
  return freezeMessage({ ...created, id: message.id as UserMessage['id'] })
}
