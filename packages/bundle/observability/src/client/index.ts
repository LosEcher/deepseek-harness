/**
 * dsh-observability — client entry: registers a '观测' conversation tab
 * ('conversation.view' slot) backed by the host half's /observability/summary
 * JSON endpoint (the same session-ledger fold as /metrics, structured for
 * the GUI).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ObservabilityTabView } from './ObservabilityTabView.tsx'

export const inject = ['slots', 'conversation']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposeTab = ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({
        name: 'conversation.view',
        id: 'observability',
        order: 96,
        label: () => '观测',
      }, props => ObservabilityTabView({ ...props })))
    return () => { disposeTab?.() }
  })
}
