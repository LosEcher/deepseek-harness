/**
 * Seam for a lab shell plugin: replace the root component and retain Sessions.
 * The plugin consumes this through `inject: ['labRoot']`; no package import of
 * ui-layout internals is needed.
 */
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RootComponent } from './root-override.ts'

/** Service exposed by the layout plugin when the seam is present. */
export interface LabRootService {
  /** Install the shell component that renders the root slot. */
  setRootComponent: (component: RootComponent) => void
  /** Retain one Session for an explicit-pane/card binding. */
  retainSession: (sessionId: string) => SessionReference
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    labRoot: LabRootService
  }
}
