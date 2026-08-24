import { describe, expect, it } from 'vitest'
import { isReadOnlyToolLabel, resolveToolAnnotations } from '../src/annotations.ts'

describe('isReadOnlyToolLabel (A4 heuristic)', () => {
  it('read verbs imply read-only', () => {
    expect(isReadOnlyToolLabel('read_file', 'Read a file')).toBe(true)
    expect(isReadOnlyToolLabel('search_code', 'Search the codebase')).toBe(true)
    expect(isReadOnlyToolLabel('list_files', 'List directory entries')).toBe(true)
    expect(isReadOnlyToolLabel('get_status', 'Fetch service status')).toBe(true)
  })

  it('write verbs defeat the read hint', () => {
    expect(isReadOnlyToolLabel('send_message', 'Send a message')).toBe(false)
    expect(isReadOnlyToolLabel('delete_file', 'Delete a file')).toBe(false)
    expect(isReadOnlyToolLabel('read_then_write', 'Read and update config')).toBe(false)
    expect(isReadOnlyToolLabel('run_task', 'Execute a task')).toBe(false)
  })

  it('unrelated labels are not read-only', () => {
    expect(isReadOnlyToolLabel('present', 'has presenters')).toBe(false)
    expect(isReadOnlyToolLabel('safe', 'parallel-safe')).toBe(false)
  })
})

describe('resolveToolAnnotations (A4)', () => {
  it('explicit annotations win over derivation', () => {
    const annotations = resolveToolAnnotations({
      name: 'read_file',
      description: 'Read a file',
      annotations: { destructiveHint: true },
    })
    expect(annotations).toEqual({ destructiveHint: true })
  })

  it('sideEffect read derives readOnlyHint + idempotentHint', () => {
    const annotations = resolveToolAnnotations({
      name: 'lookup',
      description: 'anything',
      sideEffect: 'read',
    })
    expect(annotations).toEqual({ readOnlyHint: true, idempotentHint: true })
  })

  it('label heuristic derives the read hint when sideEffect is undeclared', () => {
    expect(resolveToolAnnotations({ name: 'search', description: 'Search the code' }))
      .toEqual({ readOnlyHint: true, idempotentHint: true })
    expect(resolveToolAnnotations({ name: 'rm', description: 'Remove a file' })).toBeUndefined()
  })

  it('never derives destructiveHint from a guess', () => {
    const annotations = resolveToolAnnotations({ name: 'delete_thing', description: 'delete' })
    // mutating label → no read hint, and no destructive guess either
    expect(annotations).toBeUndefined()
  })
})
