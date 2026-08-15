/**
 * Per-boot isolation of out-of-tree profile rows that fail to import or apply.
 *
 * Installation-owned bundle rows stay fail-loud. A failed addon row is disabled
 * for this process only and boot retries; the disable is not written back.
 * @module @deepseek-ai/dsh-app-boot/addon-quarantine
 */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { bundleResolvesFromInstallation, composeEntries, type Profile } from './profile.ts'

/** Loader bootstrap include id; never treated as an addon even if listed. */
export const BOOTSTRAP_INCLUDE_ID = 'include'

/** Ids and module specifiers named in a Loader/boot failure chain. */
export interface FailedLoaderRefs {
  /** Loader entry ids from `failed to apply/import loader entry <id>`. */
  ids: string[]
  /** Plugin module specifiers / names from the same chain and the activation audit. */
  names: string[]
}

const LOADER_ENTRY_REF = /failed to (?:apply|import) loader entry ([^\s(]+) \(([^)]*)\)/g
const ACTIVATION_AUDIT = /did not activate\n([\s\S]*)$/

/**
 * Collect every Loader entry id and plugin name mentioned in a boot failure.
 * Walks `cause` and `AggregateError.errors`; ignores non-Error values.
 * @param error - a thrown boot or Loader value.
 * @returns unique ids and names in first-seen order.
 */
export function collectFailedLoaderRefs(error: unknown): FailedLoaderRefs {
  const ids: string[] = []
  const names: string[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const addId = (id: string) => {
    if (seenIds.has(id)) return
    seenIds.add(id)
    ids.push(id)
  }
  const addName = (name: string) => {
    if (name === '' || seenNames.has(name)) return
    seenNames.add(name)
    names.push(name)
  }
  const walk = (value: unknown): void => {
    if (!(value instanceof Error)) return
    for (const match of value.message.matchAll(LOADER_ENTRY_REF)) {
      const id = match[1]
      const name = match[2]
      if (id === undefined || name === undefined) continue
      addId(id)
      addName(name)
    }
    const audit = ACTIVATION_AUDIT.exec(value.message)
    const auditBody = audit?.[1]
    if (auditBody !== undefined) {
      for (const line of auditBody.split('\n')) {
        const cut = line.indexOf(': ')
        if (cut > 0) addName(line.slice(0, cut))
      }
    }
    if ('errors' in value && Array.isArray((value as AggregateError).errors)) {
      for (const inner of (value as AggregateError).errors) walk(inner)
    }
    walk(value.cause)
  }
  walk(error)
  return { ids, names }
}

/**
 * Walk a composed entry list (including group children) and collect every id.
 * @param entries - composed Loader rows.
 * @returns unique ids in visit order.
 */
export function collectEntryIds(entries: readonly EntryOptions[]): string[] {
  const ids: string[] = []
  const visit = (rows: readonly EntryOptions[]) => {
    for (const row of rows) {
      if (typeof row.id === 'string') ids.push(row.id)
      if (row.group === true && Array.isArray(row.config)) visit(row.config as EntryOptions[])
    }
  }
  visit(entries)
  return ids
}

/**
 * Map plugin names from a failure onto composed row ids.
 * @param entries - composed rows (groups walked).
 * @param names - module specifiers or plugin names from {@link collectFailedLoaderRefs}.
 * @returns matching row ids.
 */
export function entryIdsForNames(entries: readonly EntryOptions[], names: readonly string[]): string[] {
  const wanted = new Set(names)
  const ids: string[] = []
  const visit = (rows: readonly EntryOptions[]) => {
    for (const row of rows) {
      if (typeof row.id === 'string' && typeof row.name === 'string' && wanted.has(row.name)) ids.push(row.id)
      if (row.group === true && Array.isArray(row.config)) visit(row.config as EntryOptions[])
    }
  }
  visit(entries)
  return ids
}

/**
 * Addon row ids: every composed id that is not inserted by an installation-owned
 * bundle layer. User-layer inserts and out-of-tree bundle inserts are addons;
 * id-targeted overrides of installation-owned rows stay core.
 * @param installationOwnedPatches - patch lists from bundles that resolve at the install anchor.
 * @param allLayers - every patch list in application order (installation, out-of-tree, user, overlays).
 * @returns addon entry ids.
 */
export function collectAddonEntryIds(
  installationOwnedPatches: readonly PatchOptions[][],
  allLayers: readonly PatchOptions[][],
): Set<string> {
  const core = new Set(collectEntryIds(composeEntries(installationOwnedPatches)))
  const addon = new Set<string>()
  for (const id of collectEntryIds(composeEntries(allLayers))) {
    if (!core.has(id)) addon.add(id)
  }
  return addon
}

/**
 * Addon row ids for one loaded profile plus extra overlay layers.
 * @param profile - loaded profile (bundle layers + user layer).
 * @param installAnchor - absolute path of the dsh app's package.json.
 * @param extraLayers - home-level and launcher overlay patch lists, in order.
 * @returns addon entry ids.
 */
export function profileAddonEntryIds(
  profile: Profile,
  installAnchor: string,
  extraLayers: readonly PatchOptions[][] = [],
): Set<string> {
  const owned = profile.layers
    .filter(layer => bundleResolvesFromInstallation(layer.packageName, installAnchor))
    .map(layer => layer.patches)
  return collectAddonEntryIds(owned, [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    ...extraLayers,
  ])
}
