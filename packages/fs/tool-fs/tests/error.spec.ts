/**
 * Unit tests for the model-facing error remediation: the remedy appended to
 * guarded-mutation failures, code preservation, and passthrough behavior.
 */

import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { remediateFsError } from '../src/error.ts'
import { locateClosestLine } from '../src/edit.ts'

describe('remediateFsError', () => {
  it('appends the re-read remedy to FS_STALE_VERSION, preserving the code and chaining the cause', () => {
    const original = new FsError('cannot edit "x": file changed since it was read', 'FS_STALE_VERSION')
    const remedied = remediateFsError(original) as FsError
    expect(remedied).toBeInstanceOf(FsError)
    expect(remedied.message).toBe('cannot edit "x": file changed since it was read — re-read the file, then retry')
    expect(remedied.code).toBe('FS_STALE_VERSION')
    expect(remedied.cause).toBe(original)
  })

  it('appends the read remedy to FS_NOT_OBSERVED', () => {
    const remedied = remediateFsError(new FsError('edit requires reading "x" first', 'FS_NOT_OBSERVED')) as FsError
    expect(remedied.message).toBe('edit requires reading "x" first — read the file, then retry')
    expect(remedied.code).toBe('FS_NOT_OBSERVED')
  })

  it('leaves other FsError codes untouched', () => {
    const original = new FsError('no match anywhere', 'FS_EDIT_NOT_FOUND')
    expect(remediateFsError(original)).toBe(original)
  })

  it('leaves non-FsError values untouched', () => {
    const original = new Error('boom')
    expect(remediateFsError(original)).toBe(original)
  })
})

describe('locateClosestLine (C4 差异行定位)', () => {
  it('prefers an exact containment hit and reports the 1-based line', () => {
    const loc = locateClosestLine('line one\nkeep me here\nline three', 'keep me')
    expect(loc).toEqual({ line: 2, snippet: 'keep me here' })
  })

  it('falls back to the highest character-overlap line when the needle vanished', () => {
    const loc = locateClosestLine('goodbye', 'world')
    expect(loc).toEqual({ line: 1, snippet: 'goodbye' })
  })

  it('uses the first non-empty line of a multi-line oldString as the needle', () => {
    const loc = locateClosestLine('alpha\nbeta gamma', '\nbeta gamma\n')
    expect(loc).toEqual({ line: 2, snippet: 'beta gamma' })
  })

  it('caps the snippet to maxSnippet characters', () => {
    const long = 'x'.repeat(200)
    const loc = locateClosestLine(long, 'x')
    expect(loc?.snippet).toHaveLength(80)
  })

  it('returns undefined for a blank oldString or an empty file', () => {
    expect(locateClosestLine('anything', '   \n\t')).toBeUndefined()
    expect(locateClosestLine('', 'needle')).toBeUndefined()
  })

  it('returns undefined when no line shares characters with the needle', () => {
    expect(locateClosestLine('abc', 'xyz')).toBeUndefined()
  })
})
