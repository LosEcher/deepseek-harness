/** Resolve the shell at render time so a late plugin override still applies. */
import { useSyncExternalStore } from 'react'
import { AppFrame } from './AppFrame.tsx'
import { rootComponent, subscribeRootComponent, type RootComponent } from './root-override.ts'

export function RootOutlet(props: Record<string, unknown>) {
  const Shell = useSyncExternalStore(subscribeRootComponent, () => rootComponent(AppFrame as unknown as RootComponent))
  return <Shell {...props} />
}
