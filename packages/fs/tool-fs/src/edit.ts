/**
 * Model-facing literal edit, unique-match by default. It obtains an optional guard from the
 * single intent slot, calls `ctx.fs.editText` without a separate stat, then records the observed
 * version; no policy means an unconditional atomic edit.
 * @module @deepseek-ai/dsh-tool-fs/src/edit
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** Validated `edit` arguments after defaulting. */
interface EditInput {
  filePath: string
  oldString: string
  newString: string
  replaceAll: boolean
}

/**
 * The `edit` tool's validated arguments: the base parameters plus the two
 * escalation fields, advertised only under a confining `ctx.fs` (absent from
 * the schema otherwise, so the validator rejects them before `execute`).
 */
interface EditToolArgs {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
  sandbox_permissions?: string
  justification?: string
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `file_path`, a non-empty `old_string`, and `old_string !== new_string`
 * (an equal pair would be a guaranteed no-op edit).
 * @param args - the schema-validated raw tool arguments.
 * @returns the camelCased input with `replace_all` defaulted to false.
 */
export function parseEditArgs(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

/**
 * Format an edit success (single-match or replace-all) as a Claude-style model-facing message.
 * @param displayPath - the backend-resolved path shown to the model.
 * @param replaceAll - selects the all-occurrences wording over the single-replacement one.
 * @returns the confirmation sentence the model sees as the tool result.
 */
export function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
}

/**
 * Locate the content line closest to `oldString` in the current file, for the
 * stale-edit conflict error (C4: 差异行定位). Uses the first non-empty line of
 * `oldString` as the needle; exact containment wins, otherwise the line with the
 * highest character-overlap ratio is returned. `undefined` means no usable line
 * (e.g. an empty file or a blank needle).
 * @param content - the current file content (as read back after the stale retry failed).
 * @param oldString - the edit's literal search text.
 * @param maxSnippet - cap for the returned line snippet.
 * @returns 1-based line number and its trimmed snippet, or undefined.
 */
export function locateClosestLine(
  content: string,
  oldString: string,
  maxSnippet = 80,
): { line: number; snippet: string } | undefined {
  const needle = oldString.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (!needle) return undefined
  const lines = content.split('\n')
  // Exact containment first: the surrounding lines usually survived the change.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && line.includes(needle)) {
      return { line: i + 1, snippet: line.trim().slice(0, maxSnippet) }
    }
  }
  // Otherwise the highest character-overlap line (cheap and deterministic).
  const needleChars = new Set(needle)
  let best: { line: number; score: number } | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim().length === 0) continue
    const lineChars = new Set(line)
    let common = 0
    for (const ch of lineChars) if (needleChars.has(ch)) common++
    const score = common / Math.max(needleChars.size, lineChars.size)
    if (!best || score > best.score) best = { line: i + 1, score }
  }
  if (!best || best.score <= 0) return undefined
  const snippetLine = lines[best.line - 1]
  return snippetLine === undefined
    ? undefined
    : { line: best.line, snippet: snippetLine.trim().slice(0, maxSnippet) }
}

/**
 * Build the model-facing conflict error for a stale edit whose automatic retry
 * failed to match (C4 方案 A 兜底 B). Reads the current content back to locate
 * the closest line, so the model gets a locatable diff anchor instead of a bare
 * retry hint. Non-match errors (FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT) are
 * re-coded to FS_STALE_VERSION with the located line; anything else (e.g. a
 * second FS_STALE_VERSION race, binary-content change) passes through untouched.
 * @param ctx - plugin context (for the re-read).
 * @param target - the resolved edit target.
 * @param input - the validated edit input.
 * @param retryError - the error the unconditional retry threw.
 * @param signal - the execution abort signal.
 * @returns the conflict FsError, or the original error when it is not a match failure.
 */
async function staleEditConflictError(
  ctx: Context,
  target: FsTarget,
  input: EditInput,
  retryError: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!(retryError instanceof FsError)) return retryError
  if (retryError.code !== 'FS_EDIT_NOT_FOUND' && retryError.code !== 'FS_AMBIGUOUS_EDIT') {
    return retryError
  }
  let current: string
  try {
    current = await ctx.fs.readText(target, signal)
  } catch {
    return retryError
  }
  const loc = locateClosestLine(current, input.oldString)
  const where = loc ? `; closest content near line ${loc.line}: ${JSON.stringify(loc.snippet)}` : ''
  return new FsError(
    `cannot edit "${target.displayPath}": the file changed since it was read and old_string no longer uniquely matches${where}`,
    'FS_STALE_VERSION',
    { cause: retryError },
  )
}

/**
 * Register the `edit` tool and its system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API (advertisement, mode stamping, denial mapping).
 */
export function applyEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace. Must match exactly.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatEditOutput(value.path, args.replace_all ?? false),
      }],
      presentationMeta: (args, value) => ({
        diffs: computeHunkDiffs(args.file_path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: EditToolArgs, exec) {
      const input = parseEditArgs(args)
      // Resolve the per-call sandbox policy (approved mode > session override
      // > backend default, plus the session cwd root) BEFORE anything executes.
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot))
      // Single-slot decision: the policy plugin returns { version: vObserved } or
      // throws FS_NOT_OBSERVED; the bare default is undefined (unconditional edit).
      // No stat — the bare default never manufactures a version basis. The intent
      // slot itself can throw FS_NOT_OBSERVED for an unread target, so it sits
      // inside the try: both that refusal and the provider's guarded-mutation
      // failure get the model-facing remedy below.
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        outcome = await ctx.fs.editText(
          target,
          { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
          intent,
          exec.signal,
          sandboxPolicy,
        )
      } catch (error: unknown) {
        // A sandbox denial becomes the shared [sandbox: …] marker (the model
        // recognizes it from bash); stale/not-observed failures gain their
        // model-facing remedy; anything else passes through.
        const mapped = sandbox.mapError(error, sandboxPolicy)
        // C4 方案 A: an FS_STALE_VERSION (the file changed since this session's
        // read) is retried ONCE unconditionally. The provider's per-target lock
        // performs an atomic read→match→write against the CURRENT content, so
        // the retry either succeeds when old_string still matches exactly once
        // (external changes elsewhere in the file do not block it), or fails
        // with a match error when the content really changed at the edit site.
        // Unconditional here is deliberate: the whole point is to re-baseline on
        // the fresh content rather than on the stale observation. A failed retry
        // is re-coded into a locatable-diff error (staleEditConflictError); a
        // second staleness race passes through as-is.
        if (mapped instanceof FsError && mapped.code === 'FS_STALE_VERSION') {
          try {
            outcome = await ctx.fs.editText(
              target,
              { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll },
              undefined,
              exec.signal,
              sandboxPolicy,
            )
          } catch (retryError: unknown) {
            const retryMapped = sandbox.mapError(retryError, sandboxPolicy)
            throw remediateFsError(await staleEditConflictError(ctx, target, input, retryMapped, exec.signal))
          }
        } else {
          throw remediateFsError(mapped)
        }
      }
      // Record the present observation (a no-op when no policy plugin listens).
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return {
        path: target.displayPath,
        before: outcome.before,
        after: outcome.after,
      }
    },
    // Pure display: a diff card of the literal replacement (old_string → new_string), derived
    // from the call args. `oldText: old_string || null` matches claude-agent-acp's Edit arm;
    // new_string is a required arg here, so it maps straight to newText.
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    // Applied metadata replaces the call-time snippet; errors or malformed replay metadata use
    // the generic result rendering.
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.file_path}`, diffs }
    },
  }))
}
