/**
 * Tool read-only / destructive annotations (A4, grok-bot borrow).
 *
 * `ToolSchema.annotations` (OpenAI annotations vocabulary) tells the model
 * about a tool's side effects. Tools may declare `annotations` explicitly;
 * otherwise we derive a read-only hint from `sideEffect: 'read'` or from a
 * name/description heuristic (ported from grok-bot's `isReadOnly`).
 */

import type { ToolAnnotations } from '@deepseek-ai/dsh-llm'

/** Verb prefixes that usually mark a read-only operation. */
const READ_VERBS =
  /\b(read|search|find|list|get|fetch|query|lookup|inspect|view|download|retrieve|peek|stat|ls|cat|head|tail|grep|glob)\b/i
/** Verbs that mark a mutating operation; their presence defeats the read hint. */
const WRITE_VERBS = new RegExp(
  '\\b(send|create|update|delete|remove|write|upload|post|reply|archive|move|rename|modify|cancel|' +
    'purchase|buy|execute|run|spawn|install|edit|patch|put|push|rm|cp|mv|mkdir|touch)\\b',
  'i',
)

/** Heuristic read-only classification over a tool's name + description. */
export function isReadOnlyToolLabel(name: string, description: string): boolean {
  const label = `${name} ${description}`
  return READ_VERBS.test(label) && !WRITE_VERBS.test(label)
}

/**
 * Resolve the model-facing annotations for one tool:
 * explicit `annotations` win; else derive a read-only hint from
 * `sideEffect: 'read'` (authoritative) or the label heuristic.
 * Never derives `destructiveHint` (too risky to guess) — mutating tools
 * simply omit it.
 */
export function resolveToolAnnotations(input: {
  name: string
  description: string
  sideEffect?: 'read' | 'write'
  annotations?: ToolAnnotations
}): ToolAnnotations | undefined {
  if (input.annotations !== undefined && Object.keys(input.annotations).length > 0) {
    return { ...input.annotations }
  }
  const readOnly = input.sideEffect === 'read' || isReadOnlyToolLabel(input.name, input.description)
  return readOnly ? { readOnlyHint: true, idempotentHint: true } : undefined
}
