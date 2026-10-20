/** POC: a two-pane dock proving explicit per-pane Session bindings. */
import { useEffect, useState } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { retainDockSession } from './dock-host.ts'

const FLAG = 'dsh.shellDock'

/** Read the POC flag once; a reload is the intended toggle. */
export function dockEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG) === '1' } catch { return false }
}

/**
 * Two panes: the left one inherits the shell's current Session, the right one
 * is bound to a different Session through an explicit reference. Splitting the
 * right pane in is the smallest proof that the shell can host more than one
 * `main` panel with independent Session bindings.
 */
export function DockView({ renderSlot, useSessions }: {
  renderSlot: PropsRenderSlots<'main'>['renderSlot']
  useSessions: PropsRuntime<'root'>['useSessions']
}) {
  const list = useSessions(state => state)
  const [rightId, setRightId] = useState<string | null>(null)
  // State, not a ref: the pane must re-render once the explicit reference exists,
  // otherwise its first render would silently inherit the current Session.
  const [reference, setReference] = useState<SessionReference | null>(null)

  useEffect(() => {
    if (rightId === null) { setReference(null); return }
    let ref: SessionReference | null = null
    let cancelled = false
    try { ref = retainDockSession(rightId) } catch { ref = null }
    if (ref !== null) {
      // The explicit area stays empty until the shared initial open settles,
      // so publish the reference only after `ready` (same rule as SessionSplitCard).
      void ref.ready.then(() => { if (!cancelled) setReference(ref) }).catch(() => { ref?.release() })
    }
    return () => { cancelled = true; setReference(null); ref?.release() }
  }, [rightId])

  const candidate = list.ids.find(id => id !== rightId && (list.byId[id]?.retainedBy?.mainView ?? 0) === 0)
  const addPane = () => {
    if (candidate === undefined) return
    setRightId(candidate)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', minHeight: 0, gap: 8 }}>
      <section data-dock-pane="a" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 }}>
        {renderSlot('main', {}, { entryKey: 'conversation' })}
      </section>
      {rightId === null ? (
        <button type="button" data-dock-split onClick={addPane} disabled={candidate === undefined} style={{ alignSelf: 'flex-start', marginTop: 8 }}>
          Split
        </button>
      ) : (
        <section data-dock-pane="b" data-dock-ref={reference?.sessionId ?? 'none'} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 }}>
          {renderSlot('main', { session: reference ?? undefined }, { entryKey: 'conversation' })}
        </section>
      )}
    </div>
  )
}
