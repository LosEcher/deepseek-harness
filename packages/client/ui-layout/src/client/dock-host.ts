/** POC bridge: the shell dock needs session retention without a new slot inject. */
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    shellDock: unknown
  }
}

type Retain = (sessionId: string) => SessionReference

let retain: Retain | undefined

/** Installed by the layout plugin's apply (single client root). */
export function setDockRetain(fn: Retain): void {
  retain = fn
}

/** Retain one pane's Session; throws when the layout plugin is not applied. */
export function retainDockSession(sessionId: string): SessionReference {
  if (retain === undefined) throw new Error('shell dock: sessions service is not available')
  return retain(sessionId)
}
