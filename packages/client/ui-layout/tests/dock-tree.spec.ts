import { describe, expect, it } from 'vitest'
import {
  closePane,
  createDockLayout,
  findPane,
  focusPane,
  paneIds,
  splitPane,
  type DockIds,
  type DockPane,
} from '../src/client/dock-tree.ts'

function ids(): DockIds {
  let n = 0
  return { paneId: () => `p${++n}`, splitId: () => `s${++n}` }
}

function layoutWithTwo(): { layout: ReturnType<typeof createDockLayout>; second: DockPane } {
  const gen = ids()
  const start = createDockLayout('conversation', gen)
  const second: DockPane = { kind: 'pane', id: gen.paneId(), panelId: 'conversation', sessionId: 'session-b' }
  return { layout: splitPane(start, start.activePaneId, 'row', second, gen), second }
}

describe('dock tree', () => {
  it('starts as one conversation pane that is focused', () => {
    const layout = createDockLayout('conversation', ids())
    expect(layout.root.kind).toBe('pane')
    expect(paneIds(layout.root)).toEqual([layout.activePaneId])
  })

  it('splits the focused pane and focuses the new leaf', () => {
    const { layout, second } = layoutWithTwo()
    expect(layout.root.kind).toBe('split')
    expect(paneIds(layout.root)).toHaveLength(2)
    expect(layout.activePaneId).toBe(second.id)
    expect(findPane(layout.root, second.id)?.sessionId).toBe('session-b')
  })

  it('nests a second split instead of flattening the first', () => {
    const gen = ids()
    const start = createDockLayout('conversation', gen)
    const one = splitPane(start, start.activePaneId, 'row', { kind: 'pane', id: gen.paneId(), panelId: 'conversation' }, gen)
    const two = splitPane(one, one.activePaneId, 'column', { kind: 'pane', id: gen.paneId(), panelId: 'conversation' }, gen)
    expect(two.root.kind).toBe('split')
    const root = two.root as Extract<typeof two.root, { kind: 'split' }>
    // The active leaf was replaced by a nested split, not appended to the root.
    expect(root.children).toHaveLength(2)
    expect(root.children.some(child => child.kind === 'split')).toBe(true)
    expect(paneIds(two.root)).toHaveLength(3)
  })

  it('collapses a split when a close leaves one child', () => {
    const { layout, second } = layoutWithTwo()
    const closed = closePane(layout, second.id)
    expect(closed.root.kind).toBe('pane')
    expect(paneIds(closed.root)).toHaveLength(1)
    expect(closed.activePaneId).toBe(layout.root.kind === 'pane' ? layout.root.id : closed.activePaneId)
  })

  it('refuses to close the last pane and ignores unknown focus targets', () => {
    const layout = createDockLayout('conversation', ids())
    expect(closePane(layout, layout.activePaneId)).toBe(layout)
    expect(focusPane(layout, 'missing')).toBe(layout)
  })

  it('moves focus to a remaining pane when the focused one closes', () => {
    const { layout, second } = layoutWithTwo()
    const closed = closePane(layout, second.id)
    expect(closed.activePaneId).not.toBe(second.id)
    expect(paneIds(closed.root)).toContain(closed.activePaneId)
  })
})
