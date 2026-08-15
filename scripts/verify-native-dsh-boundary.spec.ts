/**
 * Spec for the native-dsh boundary gate: the Rust migration must stay a
 * vacuum until a facade package with its own conformance suite exists.
 */
import { describe, expect, test } from 'vitest'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

describe('native-dsh boundary gate', () => {
  test('product tree contains no Rust migration packages', () => {
    const configFiles = globSync('**/*cordis*.yml', { cwd: root })
    expect(configFiles.length).toBeGreaterThan(0)
    for (const file of configFiles) {
      const content = readText(resolve(root, file))
      for (const banned of ['dsh-sidecar', 'dsh-bridge-protocol', 'dsh-bridge-runtime']) {
        const pattern = new RegExp(`(^|[^-A-Za-z0-9_])${banned}($|[^-A-Za-z0-9_])`)
        const lines = content.split('\n')
        for (const [index, line] of lines.entries()) {
          if (pattern.test(line) && !line.trim().startsWith('#')) {
            expect.fail(`${file}:${index + 1} references banned Rust package ${banned}`)
          }
        }
      }
    }
  })

  test('packages and apps never spawn the sidecar binary', () => {
    const scopes = globSync(['packages/*/src/**/*', 'packages/*/tests/**/*', 'apps/*/src/**/*'], {
      cwd: root,
    })
    const offenders = scopes.filter(file => /\.(ts|tsx|mts|cts|mjs|js)$/.test(file) && (
      readText(resolve(root, file)).includes('CARGO_BIN_EXE_dsh-sidecar') ||
      readText(resolve(root, file)).includes('"dsh-sidecar"')
    ))
    expect(offenders).toEqual([])
  })

  test('migration ledger and matrix exist together', () => {
    const ledgerExists = existsSync(resolve(root, 'native/dsh/migration/package-map.json'))
    const matrixExists = existsSync(resolve(root, 'docs/rust-migration-matrix.md'))
    expect(ledgerExists).toBe(matrixExists)
  })
})

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}
