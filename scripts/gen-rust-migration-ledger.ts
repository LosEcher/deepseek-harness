/**
 * Generate the Rust migration ledger and its human matrix.
 *
 * Inventory comes from every DSH `package.json`, in-repo peer-dependency
 * edges, the capability-seams role table, shipped Cordis compositions, and
 * bundle patches. Maintainers record disposition in
 * `native/dsh/migration/overrides.json`. `--check` verifies both artifacts.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import * as yaml from 'js-yaml'
import { SERVICE_ROLES } from './service-roles.ts'
import { collectPackageGraph, type PackageGraphNode } from './package-graph.ts'
import { cordisConfigFiles } from './cordis-config-files.ts'

const root = resolve(import.meta.dirname, '..')

/** Machine-readable ledger emitted beside the native workspace. */
export const LEDGER_REL = 'native/dsh/migration/package-map.json'

/** Generated human view of the ledger. */
export const MATRIX_REL = 'docs/rust-migration-matrix.md'

/** Maintainer overlay merged into every generated row. */
export const OVERRIDES_REL = 'native/dsh/migration/overrides.json'

const SCOPE = '@deepseek-ai/dsh-'
const LEDGER_FORMAT_VERSION = 1

const GROUP_ORDER = [
  'util',
  'attachment',
  'llm',
  'core',
  'typert',
  'goal',
  'subprocess',
  'shell',
  'terminal',
  'sandbox',
  'e2b',
  'fs',
  'skill',
  'compaction',
  'subagent',
  'jobs',
  'workflow',
  'web',
  'spill',
  'todo',
  'plan',
  'hooks',
  'session',
  'session-query',
  'settings',
  'credentials',
  'storage',
  'workspace',
  'support',
  'acp',
  'sdk',
  'interaction',
  'boot',
  'host',
  'client',
  'examples',
  'test-support',
  'bundle',
  'preset',
  'guard',
  'extensions',
  'code-runtime',
  'context',
  'feedback',
  'identity',
  'lsp',
  'mcp',
  'api',
  'schedule',
]

/** Replacement phase that owns a package, or null when none is assigned. */
export type MigrationPhase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9'

/** What happens to the TypeScript package when its capability moves. */
export type Disposition = 'replace' | 'retain-typescript' | 'do-not-port'

/** How far the Rust implementation has progressed. */
export type MigrationStatus = 'unmigrated' | 'prototype' | 'facade' | 'migrated'

/** Declared runtime placement for a future Rust module. */
export type Placement = 'in_process' | 'resident_worker' | 'task_worker'

/** Capability-seam role a package plays for one or more services. */
export type CapabilityRole = 'definition' | 'provider' | 'consumer' | 'companion'

/** One package row in the generated ledger. */
export interface LedgerPackage {
  package: string
  name: string
  group: string
  rel: string
  deps: string[]
  roles: CapabilityRole[]
  compositions: string[]
  patches: string[]
  disposition: Disposition
  targetCrate: string | null
  phase: MigrationPhase | null
  status: MigrationStatus
  fixtures: string[]
  placement: Placement | null
  removeAfter: string | null
}

/** Generated ledger document. */
export interface Ledger {
  formatVersion: typeof LEDGER_FORMAT_VERSION
  packages: LedgerPackage[]
}

/** Maintainer fields overlaid onto an inventoried package. */
export interface OverrideEntry {
  disposition?: Disposition
  targetCrate?: string | null
  phase?: MigrationPhase | null
  status?: MigrationStatus
  fixtures?: string[]
  placement?: Placement | null
  removeAfter?: string | null
}

/** Maintainer overlay: group defaults plus per-package fields. */
export interface Overrides {
  groupDefaults?: Record<string, OverrideEntry>
  packages?: Record<string, OverrideEntry>
}

interface JsExpr {
  __jsExpr: string
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

const PHASES = new Set<MigrationPhase>(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'])
const DISPOSITIONS = new Set<Disposition>(['replace', 'retain-typescript', 'do-not-port'])
const STATUSES = new Set<MigrationStatus>(['unmigrated', 'prototype', 'facade', 'migrated'])
const PLACEMENTS = new Set<Placement>(['in_process', 'resident_worker', 'task_worker'])

/**
 * Build the complete ledger from the current tree and overlay.
 * @returns the deterministic ledger document.
 */
export function buildLedger(): Ledger {
  const pkgs = collectPackageGraph(root, GROUP_ORDER, 'gen-rust-migration-ledger')
  const overrides = readOverrides()
  const unknown = Object.keys(overrides.packages ?? {}).filter(name => !pkgs.some(pkg => pkg.short === name))
  if (unknown.length > 0) {
    throw new Error(`gen-rust-migration-ledger: overlay names unknown packages: ${unknown.sort().join(', ')}`)
  }
  const roles = collectRoles()
  const compositions = collectCompositionRefs()
  const packages = pkgs.map(pkg => rowFor(pkg, overrides, roles.get(pkg.short) ?? [], compositions))
  const ledger: Ledger = { formatVersion: LEDGER_FORMAT_VERSION, packages }
  assertLedgerInvariants(ledger)
  return ledger
}

/**
 * Render the human matrix from a ledger.
 * @param ledger - generated ledger document.
 * @returns markdown for `docs/rust-migration-matrix.md`.
 */
export function renderMatrix(ledger: Ledger): string {
  const counts = countBy(ledger.packages, row => row.status)
  const phaseCounts = countBy(ledger.packages.filter(row => row.phase !== null), row => row.phase ?? 'none')
  const rows = ledger.packages.map((row) => {
    const name = `[\`${row.package}\`](../${row.rel})`
    return `| ${name} | \`${row.group}\` | ${cellList(row.roles)} | ${cell(row.phase)} | \`${row.status}\` | \`${row.disposition}\` | ${cell(row.targetCrate)} | ${cell(row.placement)} | ${cellList(row.compositions)} | ${cellList(row.patches)} | ${cellList(row.deps)} | ${cell(row.removeAfter)} | ${cellList(row.fixtures)} |`
  })
  return [
    '<!-- Generated by scripts/gen-rust-migration-ledger.ts — do not edit by hand.',
    '     Run `pnpm run gen-rust-migration-ledger` to regenerate. -->',
    '',
    '# Rust migration matrix',
    '',
    'Inventory of every `@deepseek-ai/dsh-*` package and the Rust provider assigned to it, if any. The machine-readable ledger is [`native/dsh/migration/package-map.json`](../native/dsh/migration/package-map.json). Maintainers edit [`native/dsh/migration/overrides.json`](../native/dsh/migration/overrides.json); the generator inventories packages, peer-dependency edges, capability roles, shipped compositions, and bundle patches. The [Rust capability-provider Agent Note](../.agents/notes/proposed/architecture/2026-08-15-rust-host-replacement.md) owns the phase plan; the [ledger Agent Note](../.agents/notes/implemented/process/2026-08-15-rust-migration-ledger.md) owns this generator.',
    '',
    'A profile does not default to a Rust provider until that row is `migrated`, its conformance fixtures exist, and its dependency closure names every remaining TypeScript package. `prototype` means the crate lives in `native/dsh` only. `facade` means a TypeScript coordinator may call it after the facade is allow-listed. `unmigrated` means TypeScript remains the implementation. `retain-typescript` means no Rust clone is planned. The TypeScript provider stays mountable after a row is `migrated`.',
    '',
    '## Counts',
    '',
    '| Status | Packages |',
    '| --- | --- |',
    ...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `| \`${status}\` | ${count} |`),
    '',
    '| Phase | Packages |',
    '| --- | --- |',
    ...[...phaseCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([phase, count]) => `| \`${phase}\` | ${count} |`),
    '',
    '## Inventory',
    '',
    '| Package | Group | Roles | Phase | Status | Disposition | Target crate | Placement | Compositions | Patches | Depends on | removeAfter | Fixtures |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

/**
 * Serialize the ledger with stable key order.
 * @param ledger - generated ledger document.
 * @returns JSON text with a trailing newline.
 */
export function renderLedger(ledger: Ledger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`
}

/**
 * Check migrated rows do not depend on a package absent from the ledger.
 * @param ledger - ledger under validation.
 */
export function assertLedgerInvariants(ledger: Ledger): void {
  const byShort = new Map(ledger.packages.map(row => [row.package, row]))
  const errors: string[] = []
  if (ledger.formatVersion !== LEDGER_FORMAT_VERSION) {
    errors.push(`unsupported formatVersion ${ledger.formatVersion}`)
  }
  for (const row of ledger.packages) {
    if (row.status === 'prototype' || row.status === 'facade' || row.status === 'migrated') {
      if (row.targetCrate === null || row.targetCrate === '') {
        errors.push(`${row.package}: ${row.status} rows require targetCrate`)
      }
    }
    if (row.status !== 'migrated') continue
    for (const dep of row.deps) {
      if (!byShort.has(dep)) {
        errors.push(`${row.package}: migrated row depends on unrecorded Node package ${dep}`)
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`gen-rust-migration-ledger: ${errors.join('; ')}`)
  }
}

function rowFor(
  pkg: PackageGraphNode,
  overrides: Overrides,
  roles: CapabilityRole[],
  compositions: CompositionIndex,
): LedgerPackage {
  const overlay = mergeOverlay(overrides.groupDefaults?.[pkg.group], overrides.packages?.[pkg.short])
  const disposition = overlay.disposition ?? 'replace'
  const status = overlay.status ?? 'unmigrated'
  return {
    package: pkg.short,
    name: pkg.name,
    group: pkg.group,
    rel: pkg.rel,
    deps: pkg.deps,
    roles,
    compositions: compositions.compositions.get(pkg.short) ?? [],
    patches: compositions.patches.get(pkg.short) ?? [],
    disposition,
    targetCrate: overlay.targetCrate ?? null,
    phase: overlay.phase ?? null,
    status,
    fixtures: overlay.fixtures ?? [],
    placement: overlay.placement ?? defaultPlacement(disposition, status),
    removeAfter: overlay.removeAfter ?? null,
  }
}

function defaultPlacement(disposition: Disposition, status: MigrationStatus): Placement | null {
  if (disposition !== 'replace') return null
  if (status === 'unmigrated') return null
  return 'in_process'
}

function mergeOverlay(group: OverrideEntry | undefined, pkg: OverrideEntry | undefined): OverrideEntry {
  return { ...group, ...pkg }
}

function collectRoles(): Map<string, CapabilityRole[]> {
  const roles = new Map<string, Set<CapabilityRole>>()
  const add = (name: string | undefined, role: CapabilityRole): void => {
    if (name === undefined || name === '') return
    const set = roles.get(name) ?? new Set<CapabilityRole>()
    set.add(role)
    roles.set(name, set)
  }
  for (const service of SERVICE_ROLES) {
    add(service.pkg, 'definition')
    for (const impl of service.implementations ?? []) add(impl, 'provider')
    for (const consumer of service.consumers ?? []) add(consumer, 'consumer')
    for (const companion of service.companions ?? []) add(companion, 'companion')
  }
  return new Map([...roles].map(([name, set]) => [name, [...set].sort() as CapabilityRole[]]))
}

interface CompositionIndex {
  compositions: Map<string, string[]>
  patches: Map<string, string[]>
}

function collectCompositionRefs(): CompositionIndex {
  const compositions = new Map<string, Set<string>>()
  const patches = new Map<string, Set<string>>()
  const add = (index: Map<string, Set<string>>, pkg: string, file: string): void => {
    const set = index.get(pkg) ?? new Set<string>()
    set.add(file)
    index.set(pkg, set)
  }
  for (const file of cordisConfigFiles(root)) {
    for (const name of pluginNamesIn(file)) add(compositions, name, file)
  }
  for (const file of globSync('packages/bundle/*/cordis.patch.yml', { cwd: root }).map(path => path.split(sep).join('/')).sort()) {
    for (const name of pluginNamesIn(file)) add(patches, name, file)
  }
  const freeze = (index: Map<string, Set<string>>): Map<string, string[]> =>
    new Map([...index].map(([name, files]) => [name, [...files].sort()]))
  return { compositions: freeze(compositions), patches: freeze(patches) }
}

function pluginNamesIn(file: string): string[] {
  const document: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'), { schema })
  const names: string[] = []
  walkEntry(document, names)
  return names
}

function walkEntry(value: unknown, names: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) walkEntry(entry, names)
    return
  }
  if (!isRecord(value)) return
  recordName(value.name, names)
  if (isUnknownArray(value.insert)) walkEntry(value.insert, names)
  if ((value.group === true || value.name === '@deepseek-ai/cordis-plugin-group') && isUnknownArray(value.config)) {
    walkEntry(value.config, names)
  }
  if (value.name === '@deepseek-ai/cordis-plugin-include' && isRecord(value.config) && isUnknownArray(value.config.patches)) {
    walkEntry(value.config.patches, names)
  }
}

function recordName(name: unknown, names: string[]): void {
  if (typeof name !== 'string' || !name.startsWith(SCOPE)) return
  names.push(name.slice(SCOPE.length))
}

function readOverrides(): Overrides {
  const raw = JSON.parse(readFileSync(resolve(root, OVERRIDES_REL), 'utf8')) as unknown
  if (!isRecord(raw)) throw new Error('gen-rust-migration-ledger: overlay must be an object')
  const groupDefaults = optionalMap(raw.groupDefaults, 'groupDefaults')
  const packages = optionalMap(raw.packages, 'packages')
  return { groupDefaults, packages }
}

function optionalMap(value: unknown, field: string): Record<string, OverrideEntry> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`gen-rust-migration-ledger: ${field} must be an object`)
  const out: Record<string, OverrideEntry> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = parseOverride(entry, `${field}.${key}`)
  }
  return out
}

function parseOverride(value: unknown, path: string): OverrideEntry {
  if (!isRecord(value)) throw new Error(`gen-rust-migration-ledger: ${path} must be an object`)
  const entry: OverrideEntry = {}
  if (value.disposition !== undefined) entry.disposition = enumField(value.disposition, DISPOSITIONS, `${path}.disposition`)
  if (value.status !== undefined) entry.status = enumField(value.status, STATUSES, `${path}.status`)
  if (value.phase !== undefined) {
    entry.phase = value.phase === null ? null : enumField(value.phase, PHASES, `${path}.phase`)
  }
  if (value.targetCrate !== undefined) {
    if (value.targetCrate !== null && typeof value.targetCrate !== 'string') {
      throw new Error(`gen-rust-migration-ledger: ${path}.targetCrate must be a string or null`)
    }
    entry.targetCrate = value.targetCrate
  }
  if (value.placement !== undefined) {
    entry.placement = value.placement === null ? null : enumField(value.placement, PLACEMENTS, `${path}.placement`)
  }
  if (value.removeAfter !== undefined) {
    if (value.removeAfter !== null && typeof value.removeAfter !== 'string') {
      throw new Error(`gen-rust-migration-ledger: ${path}.removeAfter must be a string or null`)
    }
    entry.removeAfter = value.removeAfter
  }
  if (value.fixtures !== undefined) {
    if (!Array.isArray(value.fixtures) || value.fixtures.some(item => typeof item !== 'string')) {
      throw new Error(`gen-rust-migration-ledger: ${path}.fixtures must be a string array`)
    }
    entry.fixtures = [...value.fixtures].sort()
  }
  return entry
}

function enumField<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`gen-rust-migration-ledger: ${path} must be one of ${[...allowed].join(', ')}`)
  }
  return value as T
}

function cell(value: string | null): string {
  return value === null || value === '' ? '—' : `\`${value}\``
}

function cellList(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.map(value => `\`${value}\``).join(', ')
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = key(row)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function writeArtifacts(ledger: Ledger): void {
  writeFileSync(resolve(root, LEDGER_REL), renderLedger(ledger))
  writeFileSync(resolve(root, MATRIX_REL), renderMatrix(ledger))
}

function checkArtifacts(ledger: Ledger): void {
  const expectedLedger = renderLedger(ledger)
  const expectedMatrix = renderMatrix(ledger)
  const stale: string[] = []
  if (readOptional(LEDGER_REL) !== expectedLedger) stale.push(LEDGER_REL)
  if (readOptional(MATRIX_REL) !== expectedMatrix) stale.push(MATRIX_REL)
  if (stale.length === 0) {
    console.log(`gen-rust-migration-ledger: ${LEDGER_REL} and ${MATRIX_REL} are up to date.`)
    return
  }
  console.error(
    `gen-rust-migration-ledger: stale artifact(s): ${stale.join(', ')}. Run \`pnpm run gen-rust-migration-ledger\` and commit both files.`,
  )
  process.exit(1)
}

function readOptional(rel: string): string | null {
  try {
    return readFileSync(resolve(root, rel), 'utf8')
  } catch {
    return null
  }
}

if (import.meta.main) {
  const ledger = buildLedger()
  if (process.argv.includes('--check')) checkArtifacts(ledger)
  else {
    writeArtifacts(ledger)
    console.log(`gen-rust-migration-ledger: wrote ${LEDGER_REL} and ${MATRIX_REL} (${ledger.packages.length} packages).`)
  }
}
