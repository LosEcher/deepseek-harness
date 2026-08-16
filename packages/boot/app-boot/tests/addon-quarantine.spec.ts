/**
 * Addon classification and per-boot quarantine of out-of-tree profile rows.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bootQuarantiningAddons,
  collectAddonEntryIds,
  collectFailedLoaderRefs,
  collectEntryIds,
  entryIdsForNames,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'
const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-addon-'))

describe('collectFailedLoaderRefs', () => {
  it('walks cause chains and AggregateError for Loader entry refs', () => {
    const inner = new Error('failed to import loader entry multimedia (dsh-multimedia): Unexpected token')
    const mid = new Error('failed to apply loader entry include (cordis:include): failed to apply loader entry multimedia (dsh-multimedia)', { cause: inner })
    const outer = new Error('dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include)', { cause: mid })
    expect(collectFailedLoaderRefs(outer)).toEqual({
      ids: ['include', 'multimedia'],
      names: ['cordis:include', 'dsh-multimedia'],
    })
    const many = new AggregateError([
      new Error('failed to apply loader entry ocr (dsh-tool-ocr): boom'),
    ], 'loader entries failed to apply')
    expect(collectFailedLoaderRefs(many).ids).toEqual(['ocr'])
  })

  it('reads plugin names from the activation audit', () => {
    const error = new Error('dsh-test-bin: 1 entry did not activate\ndsh-multimedia: cannot get property "timer" without inject')
    expect(collectFailedLoaderRefs(error).names).toEqual(['dsh-multimedia'])
  })
})

describe('collectAddonEntryIds', () => {
  it('treats out-of-tree inserts and user inserts as addons, not installation-owned rows', () => {
    const owned = [[{ insert: [{ id: 'session', name: 'dsh-session' }, { id: 'tools', name: 'dsh-tools' }] }]]
    const all = [
      ...owned,
      [{ insert: [{ id: 'multimedia', name: 'dsh-multimedia' }] }],
      [{ insert: [{ id: 'ocr', name: 'dsh-tool-ocr' }] }, { id: 'session', config: { x: 1 } }],
    ]
    expect([...collectAddonEntryIds(owned, all)].sort()).toEqual(['multimedia', 'ocr'])
    expect(collectEntryIds([{
      id: 'g',
      name: '@deepseek-ai/cordis-plugin-group',
      group: true,
      config: [{ id: 'child', name: 'c' }],
    }])).toEqual(['g', 'child'])
  })
})

describe('entryIdsForNames', () => {
  it('maps module specifiers onto composed row ids', () => {
    expect(entryIdsForNames(
      [{ id: 'multimedia', name: 'dsh-multimedia' }, { id: 'ocr', name: 'dsh-tool-ocr' }],
      ['dsh-multimedia'],
    )).toEqual(['multimedia'])
  })
})

describe('bootQuarantiningAddons', () => {
  it('boots after disabling a failed addon and leaves a core row mounted', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'ok.mjs'), 'export function apply() {}\n')
    writeFileSync(join(dir, 'bad.mjs'), 'export function apply() { throw new Error("addon boom") }\n')
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const warnings: string[] = []
    const { ctx, quarantined } = await bootQuarantiningAddons(
      NAME,
      join(dir, 'cordis.yml'),
      [{ insert: [{ id: 'ok', name: './ok.mjs' }, { id: 'bad', name: './bad.mjs' }] }],
      new Set(['bad']),
      undefined,
      undefined,
      message => warnings.push(message),
    )
    try {
      expect(quarantined).toEqual(['bad'])
      expect(warnings.some(line => line.includes('optional plugin bad'))).toBe(true)
      // The underlying cause must surface, not just the addon id
      expect(warnings.some(line => line.includes('addon boom'))).toBe(true)
      expect([...ctx.loader.entries()].some(entry => entry.options.name === './ok.mjs')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still fails loud when a non-addon row rejects', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'core.mjs'), 'export function apply() { throw new Error("core boom") }\n')
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    await expect(bootQuarantiningAddons(
      NAME,
      join(dir, 'cordis.yml'),
      [{ insert: [{ id: 'core', name: './core.mjs' }] }],
      new Set(),
    )).rejects.toThrow('plugin tree failed to load')
  })
})
