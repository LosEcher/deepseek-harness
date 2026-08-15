import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeAddedBundleImports } from '../src/plugin.ts'
import { initProfile, resolveProfileDir, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-plugin-'))

describe('probeAddedBundleImports', () => {
  it('warns when a newly added out-of-tree bundle cannot be imported', () => {
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const pkg = join(dir, 'node_modules', 'broken-addon')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: 'broken-addon',
      type: 'module',
      main: 'index.mjs',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(pkg, 'index.mjs'), 'export const x = 1 1\n')
    writeFileSync(join(pkg, 'cordis.patch.yml'), '[]\n')
    writeProfileManifest(dir, {
      name: 'dsh-profile-demo',
      dependencies: { 'broken-addon': 'link:.' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'broken-addon'] } },
    })
    const install = tmp()
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'dsh-app' }))
    const lines: string[] = []
    probeAddedBundleImports(
      { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } },
      dir,
      join(install, 'package.json'),
      message => lines.push(message),
    )
    expect(lines.join('')).toContain('broken-addon failed to import')
  })
})
