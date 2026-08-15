/**
 * Spec for the Rust migration ledger: overlay validation, migrated-closure
 * refusal, and freshness of the committed pair.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertLedgerInvariants,
  buildLedger,
  LEDGER_REL,
  MATRIX_REL,
  renderLedger,
  renderMatrix,
  type Ledger,
} from './gen-rust-migration-ledger.ts'

const root = resolve(import.meta.dirname, '..')

describe('rust migration ledger', () => {
  it('emits a ledger that matches the committed pair', () => {
    const ledger = buildLedger()
    expect(ledger.formatVersion).toBe(1)
    expect(ledger.packages.length).toBeGreaterThan(0)
    expect(ledger.packages.every(row => typeof row.phase === 'string' || row.phase === null)).toBe(true)
    expect(readFileSync(resolve(root, LEDGER_REL), 'utf8')).toBe(renderLedger(ledger))
    expect(readFileSync(resolve(root, MATRIX_REL), 'utf8')).toBe(renderMatrix(ledger))
  })

  it('records every inventoried package and rejects a migrated row whose dep is missing', () => {
    const ledger = buildLedger()
    const names = new Set(ledger.packages.map(row => row.package))
    expect(names.has('atomic-write')).toBe(true)
    expect(names.has('session-persistence-jsonl')).toBe(true)
    const atomic = ledger.packages.find(row => row.package === 'atomic-write')
    expect(atomic).toMatchObject({
      phase: 'P2',
      status: 'prototype',
      targetCrate: 'dsh-primitives',
    })
    const fsLocal = ledger.packages.find(row => row.package === 'fs-local')
    expect(fsLocal).toMatchObject({
      phase: 'P3',
      targetCrate: 'dsh-sidecar',
    })

    const broken: Ledger = {
      formatVersion: 1,
      packages: [{
        package: 'session-persistence-jsonl',
        name: '@deepseek-ai/dsh-session-persistence-jsonl',
        group: 'session',
        rel: 'packages/session/session-persistence-jsonl',
        deps: ['missing-backend'],
        roles: ['provider'],
        compositions: [],
        patches: [],
        disposition: 'replace',
        targetCrate: 'dsh-session-store',
        phase: 'P2',
        status: 'migrated',
        fixtures: [],
        placement: 'in_process',
        removeAfter: 'P9',
      }],
    }
    expect(() => assertLedgerInvariants(broken)).toThrow(/unrecorded Node package missing-backend/)
  })

  it('refuses a prototype row without a target crate', () => {
    expect(() => assertLedgerInvariants({
      formatVersion: 1,
      packages: [{
        package: 'brand',
        name: '@deepseek-ai/dsh-brand',
        group: 'util',
        rel: 'packages/util/brand',
        deps: [],
        roles: [],
        compositions: [],
        patches: [],
        disposition: 'replace',
        targetCrate: null,
        phase: 'P2',
        status: 'prototype',
        fixtures: [],
        placement: 'in_process',
        removeAfter: null,
      }],
    })).toThrow(/require targetCrate/)
  })
})
