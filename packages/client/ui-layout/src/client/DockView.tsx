/** POC: a two-pane dock proving explicit per-pane Session bindings. */
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { retainDockSession } from './dock-host.ts'

const FLAG = 'dsh.shellDock'
const RIGHT_KEY = 'dsh.shellDock.paneB'

/** Read the POC flag once; a reload is the intended toggle. */
export function dockEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG) === '1' } catch { return false }
}

function readRight(): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(RIGHT_KEY) } catch { return null }
}

function writeRight(id: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (id === null) localStorage.removeItem(RIGHT_KEY)
    else localStorage.setItem(RIGHT_KEY, id)
  } catch { /* storage unavailable */ }
}

/**
 * Two panes: the left one inherits the shell's current Session, the right one
 * is bound to an explicitly retained Session. The picker chooses that Session,
 * close releases it, and the choice survives a reload.
 */
export function DockView({ renderSlot, useSessions }: {
  renderSlot: PropsRenderSlots<'main'>['renderSlot']
  useSessions: PropsRuntime<'root'>['useSessions']
}) {
  const list = useSessions(state => state)
  const [rightId, setRightId] = useState<string | null>(readRight)
  const [active, setActive] = useState<'a' | 'b'>('b')
  const [reference, setReference] = useState<SessionReference | null>(null)

  // Validate a restored id against the live catalog; a deleted Session drops the pane.
  useEffect(() => {
    if (rightId === null || list.phase !== 'ready') return
    const rows = list.byId as Record<string, unknown>
    if (rows[rightId] === undefined) { setRightId(null); setActive('a') }
  }, [rightId, list])

  useEffect(() => {
    writeRight(rightId)
    if (rightId === null) { setReference(null); return }
    let ref: SessionReference | null = null
    let cancelled = false
    try { ref = retainDockSession(rightId) } catch { ref = null }
    if (ref !== null) {
      // The explicit area stays empty until the shared initial open settles.
      void ref.ready.then(() => { if (!cancelled) setReference(ref) }).catch(() => { ref?.release() })
    }
    return () => { cancelled = true; setReference(null); ref?.release() }
  }, [rightId])

  const options = useMemo(() => list.ids
    .filter(id => list.byId[id]?.cwd !== undefined)
    .map(id => ({ id, title: list.byId[id]?.displayTitle || id.replace(/^session-/, '').slice(0, 8) })), [list])

  const candidate = options.find(option => option.id !== rightId && (list.byId[option.id]?.retainedBy?.mainView ?? 0) === 0)
  const split = () => {
    const id = candidate?.id ?? options[0]?.id
    if (id === undefined) return
    setRightId(id); setActive('b')
  }

  const border = (selected: boolean): CSSProperties => ({
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2)',
    outline: selected ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
    outlineOffset: -2,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px' }} data-dock-toolbar>
        {rightId === null ? (
          <button type="button" data-dock-split onClick={split} disabled={candidate === undefined && options.length === 0}>
            Split
          </button>
        ) : (
          <>
            <select
              data-dock-picker
              value={rightId}
              onChange={(event) => { setRightId(event.target.value); setActive('b') }}
              style={{ maxWidth: 320 }}
            >
              {options.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
            </select>
            <button type="button" data-dock-close onClick={() => { setRightId(null); setActive('a') }}>Close</button>
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, gap: 8 }}>
        <section data-dock-pane="a" data-dock-active={active === 'a' || undefined} onClick={() => setActive('a')} style={border(active === 'a')}>
          {renderSlot('main', {}, { entryKey: 'conversation' })}
        </section>
        {rightId === null ? null : (
          <section data-dock-pane="b" data-dock-active={active === 'b' || undefined} data-dock-ref={reference?.sessionId ?? 'none'} onClick={() => setActive('b')} style={border(active === 'b')}>
            {renderSlot('main', { session: reference ?? undefined }, { entryKey: 'conversation' })}
          </section>
        )}
      </div>
    </div>
  )
}
