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

/** Install the shell component that should render the root slot. */
export function setRootComponent(component: RootComponent): void {
  override = component
}

/** Resolve the shell component, falling back to the built-in frame. */
export function rootComponent(fallback: RootComponent): RootComponent {
  return override ?? fallback
}
