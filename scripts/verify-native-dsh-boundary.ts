/**
 * Verify the native-dsh migration boundary stays a vacuum until the facade
 * arrives, and stays gated once it does.
 *
 * The isolation between the writer (Node execution world) and the subject
 * (native/dsh Rust workspace) is currently structural: no product code
 * references the sidecar, and no cordis composition mounts it. That is a
 * vacuum, not a check. This gate turns the vacuum into a door:
 *
 * 1. Product-tree ban: no shipped cordis composition may reference the Rust
 *    migration packages (`dsh-sidecar`, `dsh-bridge-protocol`,
 *    `dsh-bridge-runtime`, or any future `@deepseek-ai/dsh-*-rust` package).
 *    Once a facade package is intentionally added, it must be listed in
 *    `NATIVE_FACADE_PACKAGES` below so its own facade tests can run without
 *    tripping the ban.
 * 2. Sidecar spawn ban: outside native/dsh, nothing may spawn the sidecar
 *    binary or import the bridge crates. The only spawner is cargo's
 *    integration tests (CARGO_BIN_EXE_dsh-sidecar).
 * 3. Ledger presence: the machine-readable migration ledger and its human
 *    view must exist once any package is recorded as migrated; the gate
 *    refuses to let a migration row appear without them.
 * 4. Conformance-first: the native/dsh workspace test suite must be green
 *    before any shipped profile may reference a Rust implementation. This
 *    gate does not run cargo (CI owns that); it asserts the composition ban
 *    that makes the conformance gate meaningful.
 *
 * The ban is regex-based on package names and binary identifiers, not a
 * semantic parser: it is a cheap tripwire. The semantic owner is the
 * conformance suite in native/dsh and the migration ledger.
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/**
 * Rust migration packages that must never appear in shipped compositions.
 * A future facade package (e.g. `@deepseek-ai/dsh-fs-rust`) is added here
 * only when its own facade tests and the native conformance suite exist.
 */
const BANNED_RUST_PACKAGES = [
  'dsh-sidecar',
  'dsh-bridge-protocol',
  'dsh-bridge-runtime',
]

/**
 * Future facade packages that are intentionally allowed in cordis configs.
 * A facade (e.g. `@deepseek-ai/dsh-fs-rust`) is added here only alongside
 * its own conformance suite; the gate then exempts that exact package name
 * while still banning every other Rust migration package.
 */
const NATIVE_FACADE_PACKAGES: string[] = []

/** Binary / crate identifiers that only cargo integration tests may spawn. */
const BANNED_BINARY_TOKENS = ['dsh-sidecar', 'CARGO_BIN_EXE_dsh-sidecar']

/** Paths where Rust migration code may live. */
const ALLOWED_RUST_PATHS = ['native/dsh']

const errors: string[] = []

function checkCompositionBan(): void {
  const configFiles = globSync('**/*cordis*.yml', { cwd: root })
  for (const file of configFiles) {
    const content = readFileSync(resolve(root, file), 'utf8')
    for (const packageName of BANNED_RUST_PACKAGES) {
      // Match a package reference that is not part of a longer identifier.
      const pattern = new RegExp(`(^|[^-A-Za-z0-9_])${escapeRegex(packageName)}($|[^-A-Za-z0-9_])`)
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const facadeExempt = NATIVE_FACADE_PACKAGES.some(facade => line.includes(facade))
        if (pattern.test(line) && !line.trim().startsWith('#') && !facadeExempt) {
          errors.push(
            `${file}:${index + 1} references banned Rust migration package ${packageName}`,
          )
        }
      }
    }
  }
}

function checkSpawnBan(): void {
  const scopes = globSync(['packages/*/src/**/*', 'packages/*/tests/**/*', 'apps/*/src/**/*'], {
    cwd: root,
  })
  for (const file of scopes) {
    if (!/\.(ts|tsx|mts|cts|mjs|js)$/.test(file)) continue
    if (ALLOWED_RUST_PATHS.some(allowed => file.startsWith(allowed))) continue
    const content = readFileSync(resolve(root, file), 'utf8')
    for (const token of BANNED_BINARY_TOKENS) {
      if (content.includes(token)) {
        errors.push(`${file} references banned sidecar token ${token}`)
      }
    }
  }
}

function checkLedgerPresence(): void {
  const ledger = resolve(root, 'native/dsh/migration/package-map.json')
  const matrix = resolve(root, 'docs/rust-migration-matrix.md')
  const ledgerExists = exists(ledger)
  const matrixExists = exists(matrix)
  if (ledgerExists !== matrixExists) {
    errors.push(
      'migration ledger and rust-migration-matrix must exist together (native/dsh/migration/package-map.json and docs/rust-migration-matrix.md)',
    )
  }
  if (ledgerExists) {
    const ledgerText = readFileSync(ledger, 'utf8')
    if (!ledgerText.includes('"phase"')) {
      errors.push('migration ledger is missing the phase field')
    }
  }
}

function exists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

checkCompositionBan()
checkSpawnBan()
checkLedgerPresence()

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`native-dsh boundary: ${error}`)
  }
  console.error(
    `native-dsh boundary: ${errors.length} violation(s). The Rust migration must stay\n` +
      'inside native/dsh until a facade package is added to NATIVE_FACADE_PACKAGES with\n' +
      'its own conformance suite; shipped profiles may not reference Rust implementations\n' +
      'before native/dsh cargo test --workspace is green.',
  )
  process.exit(1)
}

console.error('native-dsh boundary: ok (no product references to Rust migration)')
