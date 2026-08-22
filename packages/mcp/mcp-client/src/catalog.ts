/**
 * MCP tool-catalog cache (W-DSH-2): a per-server, fingerprint-keyed snapshot of
 * the tool definitions a server advertised, so a lazy-starting plugin instance
 * can register the model-facing schemas WITHOUT spawning the server or waiting
 * for the initial `tools/list`. The live sync overwrites the cache once the
 * real connection settles, so the cache is only ever a fast-start fallback.
 *
 * Fingerprint semantics: the fingerprint must change whenever the cached
 * schemas could differ — transport identity (command/args/cwd or url) and the
 * *values* of env/headers (hashed, never stored in plaintext) — but not for
 * cosmetic edits (whitespace, ordering). Secrets are excluded from the cached
 * file entirely; only their hashes participate in the fingerprint.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './index.ts'

/** One cached, model-facing tool definition (post filter/truncation). */
export interface CachedToolEntry {
  /** Server-qualified public registry name (`mcp__<serverName>__<rawName>`). */
  publicName: string
  /** Raw wire name sent on `tools/call`. */
  rawName: string
  /** Model-facing description (already descriptionMaxLength-truncated). */
  description: string
  /** MCP input schema. */
  parameters: Record<string, unknown>
  /** Supported structured-output schema, when advertised. */
  structuredSchema?: unknown
  /** Whether this MCP tool requires unsupported task execution. */
  taskRequired: boolean
}

/** The on-disk catalog shape. */
export interface CachedCatalog {
  /** Fingerprint of the transport identity that produced these tools. */
  fingerprint: string
  tools: CachedToolEntry[]
}

/** One cache file per server: `join(cacheDir, '<serverName>.json')`. */
function catalogPath(cacheDir: string, serverName: string): string {
  return join(cacheDir, `${serverName}.json`)
}

/** Stable hash of one record's values (keys kept, secrets hashed, never stored). */
function valueHashes(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(record).sort()) {
    out[key] = createHash('sha256').update(record[key] ?? '').digest('hex').slice(0, 16)
  }
  return out
}

/**
 * Fingerprint of the transport identity: everything that could change the
 * advertised tool set. Env/header *values* are hashed so secrets participate
 * in invalidation without ever being written to disk.
 *
 * @param config - resolved plugin config selecting the transport.
 * @returns a stable hex fingerprint.
 */
export function catalogFingerprint(config: Config): string {
  const material = config.transport === 'stdio'
    ? {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: valueHashes(config.env),
    }
    : {
      transport: 'streamable-http',
      url: config.url,
      headers: valueHashes(config.headers),
    }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

/**
 * Read the cached catalog for one server, if present. A missing, corrupt, or
 * schema-mismatched file reads as undefined (the live sync repopulates it).
 *
 * @param cacheDir - directory holding per-server catalog files.
 * @param serverName - the server's stable namespace.
 * @returns the cached catalog, or undefined when absent/unusable.
 */
export function readCatalog(cacheDir: string, serverName: string): CachedCatalog | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(catalogPath(cacheDir, serverName), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { fingerprint, tools } = parsed as { fingerprint?: unknown; tools?: unknown }
    if (typeof fingerprint !== 'string' || !Array.isArray(tools)) return undefined
    return { fingerprint, tools: tools as CachedToolEntry[] }
  } catch {
    return undefined
  }
}

/**
 * Persist the catalog for one server (best-effort; a failed write never fails
 * the sync that produced it — the cache is a fast-start fallback only).
 *
 * @param cacheDir - directory holding per-server catalog files.
 * @param serverName - the server's stable namespace.
 * @param fingerprint - the transport fingerprint the entries were produced under.
 * @param tools - the post-filter, model-facing definitions.
 */
export function writeCatalog(
  cacheDir: string,
  serverName: string,
  fingerprint: string,
  tools: CachedToolEntry[],
): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(catalogPath(cacheDir, serverName), JSON.stringify({ fingerprint, tools }))
  } catch {
    // Best-effort; the caller continues with the live registration.
  }
}
