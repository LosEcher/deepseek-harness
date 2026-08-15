import { EntryGroup, EntryTree, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { Context, Service } from '@deepseek-ai/cordis'
import { extname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

/**
 * The entry-list YAML dialect: `!!js` scalars round-trip as expression nodes
 * the Loader evaluates at entry activation. Exported so config tooling
 * (`dsh --dump-config`) parses and prints exactly the dialect this include
 * mounts.
 */
export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

const schema = entryListSchema

const writable: Record<string, string> = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

const supported = new Set(Object.keys(writable))

const WRITE_RETRY_LIMIT = 10
const WRITE_RETRY_DELAY_MS = 50

function retryableWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

/**
 * Apply patch lists to an entry list — THE patch semantics of this include,
 * shared by mounting (`applyPatches`) and offline config tooling
 * (`dsh --dump-config`) so a dump can never drift from what boots. The input
 * is never mutated and the result is always detached from it (even with no
 * patches): patching or mounting shared entry objects would bake earlier
 * values into the cached parse, so repeated application (config hot-reloads)
 * could never revert a removed or changed patch. Inserted entries are indexed
 * as they are added, so a later patch in the same list can target a row an
 * earlier patch inserted. A patch that matches nothing warns and is skipped.
 * @param data - the parsed entry list (JSON-safe plain data).
 * @param patches - the patch list to apply, in order.
 * @param warn - sink for skipped-patch diagnostics (printf-style, `%C` = code).
 * @returns a detached entry list with every applicable patch applied.
 */
export function applyEntryPatches(
  data: EntryOptions[],
  patches: PatchOptions[] | undefined,
  warn: (message: string, ...args: any[]) => void,
): EntryOptions[] {
  data = structuredClone(data)
  if (!patches?.length) return data

  const entryMap = new Map<string, EntryOptions>()
  const buildMap = (entries: EntryOptions[]) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) {
        buildMap(entry.config)
      }
    }
  }
  buildMap(data)

  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch

    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) {
          warn('patch insert: entry %C not found', id)
          continue
        }
        if (!target.group) {
          warn('patch insert: entry %C is not a group', id)
          continue
        }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else {
        data.push(...insert)
      }
      // Index what this patch added so a LATER patch in the same list can
      // target it. Patch lists compose one layer per source (each bundle
      // layer, then the user's, then `--patch` overlays), and a layer must be
      // able to configure or disable a row an earlier layer inserted; without
      // this, inserted rows were silently unpatchable.
      buildMap(insert)
      continue
    }

    if (!id) {
      warn('patch: id is required for non-insert patches')
      continue
    }

    const target = entryMap.get(id)
    if (!target) {
      warn('patch: entry %C not found', id)
      continue
    }

    if (name && name !== target.name) {
      warn('patch: name mismatch for %C (expected %C, got %C), skipping', id, target.name, name)
      continue
    }

    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }

  return data
}

/** Object key js-yaml stores when a mapping key was a `!!js` expression node. */
const COLLAPSED_JS_EXPR_KEY = '[object Object]'

/**
 * Reject a composed entry list where a `!!js` tag collapsed into a YAML mapping.
 * An unquoted ternary (`!!js a ? b : c`) is YAML mapping syntax; js-yaml then
 * stores the expression node as the key `[object Object]`, and interpolation
 * never runs. Quote the whole expression (`!!js "a ? b : c"`). Walks the
 * composed tree only — a later overlay may replace a bad bundle row.
 * @param value - parsed entry list or any nested config value.
 * @param path - diagnostic path; defaults to the tree root.
 * @returns nothing.
 * @throws when any mapping uses `[object Object]` as a key.
 */

/**
 * [deepseek-harness] P1: entries whose config must never hot-apply (their
 * update cascade-unloads every live agent through AgentLoop.inject).
 */
const CORE_SEAM_IDS = new Set(['llm', 'session', 'agent', 'tools', 'system-prompt', 'agent-loop'])

/** Stable fingerprint of the core-seam configs in a composed entry list. */
export function coreSeamFingerprint(entries: EntryOptions[]): string {
  const seams: Record<string, unknown> = {}
  for (const entry of entries) {
    if (CORE_SEAM_IDS.has(entry.id)) seams[entry.id] = entry.config
  }
  return JSON.stringify(seams)
}

/** Ask the supervisor (dsh-web-daemon) for a graceful, drained restart. */
export function requestGracefulRestart(reason: string): void {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    writeFileSync(join(home, 'restart-request'), `${new Date().toISOString()} ${reason}\n`)
  } catch {
    // Best-effort: never fail a config load over the restart request.
  }
}

export function assertJsExprTree(value: unknown, path = 'config'): void {
  if (value === null || typeof value !== 'object') return
  if (isJsExpr(value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const label = isNamedEntry(item) ? `entry ${item.id}` : `${path}[${index}]`
      assertJsExprTree(item, label)
    })
    return
  }
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, COLLAPSED_JS_EXPR_KEY)) {
    throw new Error(
      `${path}: !!js expression was parsed as a YAML mapping. `
      + 'Quote the whole expression (e.g. key: !!js "cond ? a : b"); '
      + "an unquoted '?' or ':' is YAML mapping syntax, not JavaScript",
    )
  }
  for (const [key, item] of Object.entries(record)) {
    assertJsExprTree(item, `${path}.${key}`)
  }
}

function isNamedEntry(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
}

type ConfigUpdateStage = 'read' | 'parse' | 'validate'

interface ReadCandidate {
  content: string
  data: EntryOptions[]
}

class ConfigFileError extends Error {
  constructor(public readonly stage: ConfigUpdateStage, path: string, cause: unknown) {
    super(`failed to ${stage} config file ${path}`, { cause })
    this.name = 'ConfigFileError'
  }
}

/** Runtime patch applied to entries loaded from an included config file. */
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}

/** Config namespace for the file-backed include loader. */
export namespace Include {
  /** Config for a file-backed loader subtree. */
  export interface Config {
    /** YAML or JSON path resolved from `ctx.baseUrl`. */
    path: string
    /** Entry list written when the file does not already exist. */
    initial?: any[]
    /** Runtime patches applied after reading the file. */
    patches?: PatchOptions[]
    /** Enables loader apply/reload/unload logs for this subtree. */
    enableLogs?: boolean
  }
}

/** Loader entry tree backed by a YAML or JSON file. */
export class Include extends EntryTree {
  static inject = ['loader']

  // Tree-carrier marker (the Group plugin declares the same): this config is
  // entry and patch lists, so the Loader's `internal/config` interpolation
  // keeps it literal — a `!!js` expression inside a nested row's config
  // belongs to that row's fiber, resolving lazily in the row's own context.
  // Include's own fields (`path`, `enableLogs`) therefore stay literal too.
  static readonly [EntryGroup.key] = true

  public filename: string
  private type?: string
  private readonly: boolean
  private content?: string
  private data?: EntryOptions[]
  /** Last composed (post-patch) entry list; the P1 core-seam guard compares against it. */
  private composed?: EntryOptions[]
  private writeTask?: NodeJS.Timeout | undefined
  private pendingWrite?: EntryOptions[]
  private writeQueue: Promise<void> = Promise.resolve()
  private applyQueue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false
    this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
    const ext = extname(this.filename)
    if (!supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.type = writable[ext]
    this.readonly = !this.type
    this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href

    ctx.on('internal/update', async (config, _, next) => {
      if (config.path !== this.config.path) return next()
      await this.enqueue(async () => {
        const data = this.applyPatches(this.data!, config.patches)
        await this.root.update(data)
        this.config = config
      })
    })
  }

  /**
   * Serialize one child-tree mutation behind every earlier one. The group's
   * transactional `update` is not reentrant: two concurrent applies (the init
   * apply racing an HMR-triggered refresh from the watcher's initial scan)
   * interleave create and rollback on the same entries and strand the include
   * fiber without settling, so every apply path funnels through this queue.
   * A predecessor's failure is its own caller's outcome and never gates the
   * next task.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.applyQueue.then(task, task)
    this.applyQueue = run.then(() => {}, () => {})
    return run
  }

  private async checkAccess() {
    if (!this.type) return
    try {
      await access(this.filename, constants.W_OK)
    } catch {
      this.readonly = true
    }
  }

  private async read(forced = false): Promise<ReadCandidate | undefined> {
    let content: string
    try {
      content = await readFile(this.filename, 'utf8')
    } catch (error) {
      throw new ConfigFileError('read', this.filename, error)
    }
    if (!forced && this.content === content) return
    let data: any
    try {
      if (this.type === 'application/yaml') {
        data = yaml.load(content, { schema })
      } else if (this.type === 'application/json') {
        data = JSON.parse(content)
      } else {
        const module = await import(/* @vite-ignore */ this.filename)
        data = module.default || module
      }
    } catch (error) {
      throw new ConfigFileError('parse', this.filename, error)
    }
    if (!Array.isArray(data)) {
      throw new ConfigFileError('validate', this.filename, new TypeError('config file must be a top-level array'))
    }
    return { content, data }
  }

  private applyPatches(data: EntryOptions[], patches?: PatchOptions[]): EntryOptions[] {
    return applyEntryPatches(data, patches, (message, ...args) => {
      this.ctx.root.logger?.('loader').warn(message, ...args)
    })
  }

  async* [Service.init]() {
    let candidate: ReadCandidate
    try {
      candidate = (await this.read(true))!
    } catch (error) {
      if (!(error instanceof ConfigFileError) || error.stage !== 'read' || (error.cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      if (this.config.initial) {
        await this._writeFile(this.config.initial as any)
        candidate = (await this.read(true))!
      } else {
        throw new Error(`config file not found: ${this.filename}`)
      }
    }

    yield () => this.stop()
    await this.apply(candidate)
  }

  async stop() {
    await this.root.stop()
    await this.flushWrite()
  }

  /**
   * Re-read the file and transactionally refresh child entries when content changed.
   * @returns a promise resolving after the new tree commits, or immediately when unchanged.
   * @throws when reading, parsing, validation, application, or rollback fails; the last good tree remains active when rollback succeeds.
   */
  /**
   * Re-read the config file and re-apply it. `forced` bypasses the
   * changed-content short-circuit: the composed result also depends on
   * `config.patches`, which a caller may have updated without touching the
   * file (the config-watch refresh path) — the P1 core-seam guard in `_apply`
   * must see the new combination even when the file bytes are unchanged.
   */
  async refresh(forced = false) {
    // Read inside the queue so the changed-content check compares against the
    // predecessor's committed state, not a mid-apply snapshot.
    await this.enqueue(async () => {
      const candidate = await this.read(forced)
      if (!candidate) return
      await this._apply(candidate)
    })
  }

  private apply(candidate: ReadCandidate) {
    return this.enqueue(() => this._apply(candidate))
  }

  private async _apply(candidate: ReadCandidate) {
    const data = this.applyPatches(candidate.data, this.config.patches)
    assertJsExprTree(data)
    // [deepseek-harness] P1: core-seam config changes must NOT hot-apply.
    // AgentLoop.inject = ['agents','sessions','llm','tools','systemPrompt']:
    // updating any of those entries (or agent-loop itself) cascade-unloads
    // every live agent and cancels in-flight turns — worse than a restart.
    // Defer such edits to a graceful restart instead (daemon watches
    // $DSH_HOME/restart-request and drains with pending protection).
    // Compare composed-vs-composed: `data` is post-patch; the previous
    // composed result is tracked separately from the raw candidate.
    if (this.composed !== undefined && coreSeamFingerprint(this.composed) !== coreSeamFingerprint(data)) {
      requestGracefulRestart('core-seam config change')
      throw new Error(
        'core seam (llm/session/agent/tools/system-prompt/agent-loop) config changed; '
        + 'hot reload deferred to a graceful restart',
      )
    }
    await this.root.update(data)
    this.content = candidate.content
    this.data = candidate.data
    this.composed = data
    await this.checkAccess()
  }

  private async _writeFile(config: EntryOptions[]) {
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      this.content = yaml.dump(config, { schema })
    } else if (this.type === 'application/json') {
      this.content = JSON.stringify(config, null, 2)
    }
    await writeFile(this.filename + '.tmp', this.content!)
    for (let retry = 0; ; retry++) {
      try {
        await rename(this.filename + '.tmp', this.filename)
        return
      } catch (error) {
        if (!retryableWriteError(error) || retry >= WRITE_RETRY_LIMIT) throw error
        await delay((retry + 1) * WRITE_RETRY_DELAY_MS)
      }
    }
  }

  private writeFile(config: EntryOptions[]) {
    clearTimeout(this.writeTask)
    this.pendingWrite = config
    this.writeTask = setTimeout(() => {
      void this.flushWrite()
    }, 0)
  }

  private flushWrite(): Promise<void> {
    clearTimeout(this.writeTask)
    this.writeTask = undefined
    const config = this.pendingWrite
    this.pendingWrite = undefined
    if (config === undefined) return this.writeQueue
    const run = this.writeQueue.then(
      () => this._writeFile(config),
      () => this._writeFile(config),
    )
    this.writeQueue = run
    void run.catch((error) => {
      this.ctx.root.logger?.('loader').warn('failed to write config file %C', this.filename)
      this.ctx.root.logger?.('loader').warn(error)
    })
    return run
  }

  /** Schedule a write of the current root entry data. */
  write() {
    this.context.emit('loader/config-update')
    return this.writeFile(this.root.data)
  }
}

export default Include
