/**
 * Shell dock tree (POC): panes as leaves, splits as interior nodes.
 *
 * The current shell selects exactly one `main` panel for the whole frame. A
 * terminal-style layout instead keeps a tree where every leaf is a pane, and
 * `split` acts on the focused pane. This module is the pure model only — no
 * React, no services — so the operations stay invertible and testable before
 * any rendering or session binding changes.
 */

/** Stable pane identity within one layout. */
export type DockPaneId = string

/** One leaf: a panel instance (identified by its `main` key) plus its own session. */
export interface DockPane {
  readonly kind: 'pane'
  readonly id: DockPaneId
  /** Registered `main` slot key; `conversation` is the default. */
  readonly panelId: string
  /** Session bound to this pane; absent means "the shell's current session". */
  readonly sessionId?: string
}

/** Interior node: ordered children along one axis. */
export interface DockSplit {
  readonly kind: 'split'
  readonly id: string
  readonly dir: 'row' | 'column'
  readonly children: readonly DockNode[]
  /** Relative sizes, same length as children; normalized on every operation. */
  readonly sizes: readonly number[]
}

export type DockNode = DockPane | DockSplit

export interface DockLayout {
  readonly root: DockNode
  readonly activePaneId: DockPaneId
}

export interface DockIds {
  /** Pane id generator; injected so tests and callers stay deterministic. */
  readonly paneId: () => DockPaneId
  readonly splitId: () => string
}

let counter = 0
/** Deterministic-enough default ids for the shell (tests inject their own). */
export const defaultDockIds: DockIds = {
  paneId: () => `pane-${++counter}`,
  splitId: () => `split-${++counter}`,
}

/** Normalize sizes to sum 1 while preserving relative weights. */
function normalize(sizes: readonly number[], count: number): readonly number[] {
  const raw = sizes.length === count
    ? sizes.map(size => (Number.isFinite(size) && size > 0 ? size : 1))
    : Array.from({ length: count }, () => 1)
  const total = raw.reduce((sum, size) => sum + size, 0)
  return raw.map(size => size / total)
}

/** The layout every workspace starts from: one conversation pane. */
export function createDockLayout(panelId = 'conversation', ids: DockIds = defaultDockIds): DockLayout {
  const pane: DockPane = { kind: 'pane', id: ids.paneId(), panelId }
  return { root: pane, activePaneId: pane.id }
}

/** All pane ids in visual order. */
export function paneIds(node: DockNode): DockPaneId[] {
  return node.kind === 'pane' ? [node.id] : node.children.flatMap(paneIds)
}

/** Locate one pane, or `undefined` when the id is stale. */
export function findPane(node: DockNode, id: DockPaneId): DockPane | undefined {
  if (node.kind === 'pane') return node.id === id ? node : undefined
  for (const child of node.children) {
    const found = findPane(child, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** Replace one pane's immutable value wherever it sits. */
export function updatePane(root: DockNode, id: DockPaneId, update: (pane: DockPane) => DockPane): DockNode {
  if (root.kind === 'pane') return root.id === id ? update(root) : root
  let changed = false
  const children = root.children.map((child) => {
    const next = updatePane(child, id, update)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...root, children } : root
}

/**
 * Split `paneId` along `dir`, placing `pane` immediately after it and keeping the
 * split sizes even. Splitting the container the pane already fills nests one
 * level rather than flattening, so repeated splits stay invertible.
 */
export function splitPane(
  layout: DockLayout,
  paneId: DockPaneId,
  dir: 'row' | 'column',
  pane: DockPane,
  ids: DockIds = defaultDockIds,
): DockLayout {
  if (findPane(layout.root, paneId) === undefined) return layout
  const insert = (node: DockNode): DockNode => {
    if (node.kind === 'pane') {
      if (node.id !== paneId) return node
      return { kind: 'split', id: ids.splitId(), dir, children: [node, pane], sizes: [0.5, 0.5] }
    }
    let changed = false
    const children = node.children.map((child) => {
      const next = insert(child)
      if (next !== child) changed = true
      return next
    })
    return changed ? { ...node, children, sizes: normalize(node.sizes, node.children.length) } : node
  }
  return { root: insert(layout.root), activePaneId: pane.id }
}

/**
 * Close one pane. Closing the last pane is a no-op; a split left with one child
 * collapses into that child so no one-child splits survive.
 */
export function closePane(layout: DockLayout, paneId: DockPaneId): DockLayout {
  if (layout.activePaneId === paneId) {
    const remaining = paneIds(layout.root).filter(id => id !== paneId)
    const next = remaining[0]
    if (next === undefined) return layout
    return closePane({ ...layout, activePaneId: next }, paneId)
  }
  const remove = (node: DockNode): DockNode => {
    if (node.kind === 'pane') return node
    const children = node.children.map(child => (child.kind === 'pane' && child.id === paneId ? undefined : remove(child)))
      .filter((child): child is DockNode => child !== undefined)
    const only = children[0]
    if (children.length === 1 && only !== undefined) return only
    if (children.length === 0) return node
    return { ...node, children, sizes: normalize(node.sizes.slice(0, children.length), children.length) }
  }
  return { ...layout, root: remove(layout.root) }
}

/** Focus an existing pane; unknown ids leave the layout unchanged. */
export function focusPane(layout: DockLayout, paneId: DockPaneId): DockLayout {
  return findPane(layout.root, paneId) === undefined ? layout : { ...layout, activePaneId: paneId }
}
