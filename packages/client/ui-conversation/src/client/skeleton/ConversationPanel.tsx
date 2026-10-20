/** Root-scoped main occupant; Session binding belongs to its Conversation child. */
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, SessionAreaProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

/** Inputs for the conversation main occupant. */
interface ConversationPanelProps extends PropsRuntime<'main'>, PropsRenderSlots<'main.conversation'> {
  /**
   * Explicit Session target for this panel instance. A dock pane passes its own
   * retained reference here so two conversation panes can show different
   * sessions instead of both inheriting the shell's current one.
   */
  session?: SessionAreaProps['session']
}

/**
 * Render the Conversation with an optional explicit Session binding.
 *
 * Without `session` the child area inherits the shell's current Session; with
 * it, a dock pane can own a different Session than its siblings.
 * @param props - main-slot inputs, the declared Conversation renderer, and the
 *   optional explicit Session target.
 * @returns the Conversation subtree.
 */
export function ConversationPanel({ renderSlot, session, ...rest }: ConversationPanelProps) {
  const content = renderSlot('main.conversation', {})
  const SessionProvider = (rest as { SessionProvider?: (props: SessionAreaProps) => ReactNode }).SessionProvider
  if (session === undefined || SessionProvider === undefined) return content
  return <div data-explicit-session={session.sessionId}><SessionProvider session={session}>{content}</SessionProvider></div>
}
