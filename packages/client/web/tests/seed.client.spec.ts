import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES } from '../src/platform.ts'
import { getStaticModules } from '../src/seed.ts'

describe('getStaticModules', () => {
  it('seeds every platform word', () => {
    const table = getStaticModules()
    for (const word of PLATFORM_MODULES) {
      expect(table[word]).toBeDefined()
    }
  })

  it('answers the deleted runtime specifier with the store module', () => {
    const table = getStaticModules()
    expect(table['@deepseek-ai/dsh-client-runtime']).toBe(table['@deepseek-ai/dsh-client-store'])
    expect(table['@deepseek-ai/dsh-client-runtime/client']).toBe(table['@deepseek-ai/dsh-client-store'])
  })
})
