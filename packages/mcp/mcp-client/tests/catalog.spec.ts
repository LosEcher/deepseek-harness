/**
 * Catalog cache unit coverage: fingerprint stability/invalidations and the
 * on-disk read/write roundtrip (including the never-store-secrets rule).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogFingerprint, readCatalog, writeCatalog } from '../src/catalog.ts'
import type { Config } from '../src/index.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-catalog-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const stdio: Config = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'echo',
  args: [],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

describe('catalogFingerprint', () => {
  it('is stable for an identical transport identity', () => {
    expect(catalogFingerprint(stdio)).toBe(catalogFingerprint({ ...stdio }))
  })

  it('changes when the command changes', () => {
    expect(catalogFingerprint(stdio)).not.toBe(catalogFingerprint({ ...stdio, command: 'other' }))
  })

  it('changes when an env value changes (secrets participate in invalidation)', () => {
    const a = catalogFingerprint({ ...stdio, env: { TOKEN: 'a' } })
    const b = catalogFingerprint({ ...stdio, env: { TOKEN: 'b' } })
    expect(a).not.toBe(b)
  })

  it('is insensitive to env/headers key order', () => {
    const a = catalogFingerprint({ ...stdio, env: { A: '1', B: '2' } })
    const b = catalogFingerprint({ ...stdio, env: { B: '2', A: '1' } })
    expect(a).toBe(b)
  })

  it('changes when a streamable-http url changes', () => {
    const http = (url: string): Config => ({
      transport: 'streamable-http',
      serverName: 'web',
      url,
      headers: {},
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
    expect(catalogFingerprint(http('http://a/mcp'))).not.toBe(catalogFingerprint(http('http://b/mcp')))
  })
})

describe('catalog cache roundtrip', () => {
  it('writes and reads back the same entries', () => {
    const dir = tempDir()
    const entries = [{
      publicName: 'mcp__srv__x',
      rawName: 'x',
      description: 'd',
      parameters: { type: 'object' },
      taskRequired: false,
    }]
    writeCatalog(dir, 'srv', 'fp-1', entries)
    const read = readCatalog(dir, 'srv')
    expect(read?.fingerprint).toBe('fp-1')
    expect(read?.tools).toEqual(entries)
  })

  it('reads undefined for a missing or corrupt file', () => {
    const dir = tempDir()
    expect(readCatalog(dir, 'missing')).toBeUndefined()
    writeFileSync(join(dir, 'bad.json'), 'not json')
    expect(readCatalog(dir, 'bad')).toBeUndefined()
    writeFileSync(join(dir, 'shape.json'), JSON.stringify({ fingerprint: 42 }))
    expect(readCatalog(dir, 'shape')).toBeUndefined()
  })

  it('never stores secret values in the cached file', () => {
    const dir = tempDir()
    const fp = catalogFingerprint({ ...stdio, env: { SECRET: 'hunter2', OTHER: 'x' } })
    writeCatalog(dir, 'srv', fp, [])
    const raw = readFileSync(join(dir, 'srv.json'), 'utf8')
    expect(raw).not.toContain('hunter2')
    // But the fingerprint still reacts to the secret (cached elsewhere is
    // invalidated by the hashed value alone).
    expect(fp).not.toBe(catalogFingerprint({ ...stdio, env: { SECRET: 'other', OTHER: 'x' } }))
  })
})
