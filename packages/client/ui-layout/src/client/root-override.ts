/**
 * Root-component override seam.
 *
 * The default shell (AppFrame) stays the fallback; a lab client plugin may
 * replace it without ui-layout importing that plugin: call setRootComponent()
 * from the plugin's apply, and the root registration below picks it up.
 */
import type { ComponentType } from 'react'

/** Loose root component type: the slot machinery supplies the real props. */
export type RootComponent = ComponentType<Record<string, unknown>>

let override: RootComponent | undefined
const listeners = new Set<() => void>()

/** Install the shell component that should render the root slot. */
export function setRootComponent(component: RootComponent): void {
  override = component
  for (const listener of listeners) listener()
}

/** Subscribe to override changes (render-time resolution avoids registration order). */
export function subscribeRootComponent(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current override or the fallback; read during render. */
export function rootComponent(fallback: RootComponent): RootComponent {
  return override ?? fallback
}
