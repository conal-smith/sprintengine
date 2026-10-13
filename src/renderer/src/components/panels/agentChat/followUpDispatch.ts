import type { FollowUpBehavior } from '../../../types/workspace'

// What a message committed while the chat's agent is working does, and what
// the send button says it will do (Settings ▸ Agents, "When I send while an
// agent is working"). Enter, a plain click on send and the right-click menu's
// Send take the person's choice; Primary+Enter and a Primary-click take the
// other one, for that message only. Both are read from here, so the button
// never promises what the key would not do.
//
// A steer is offered only where the chat's provider takes a message mid-turn
// and the turn can take one now. Anywhere else the choice collapses to the
// queue, which loses nothing: a message waits in sight and goes when the turn
// ends. The alternate there is what Primary+Enter always did for a provider
// that cannot steer: stop the turn, and let the queue send the message.

/**
 * `send` is an ordinary send (no turn to wait on); `queue` waits for the turn
 * to end; `steer` goes into the running turn; `stop-and-send` stops the turn
 * and sends the message once it has.
 */
export type ComposerDispatch = 'send' | 'queue' | 'steer' | 'stop-and-send'
export type FollowUpAction = Exclude<ComposerDispatch, 'send'>

export function resolveComposerDispatch(input: {
  /** The chat cannot take a turn now: one is running, a request waits, a send is on its way. */
  busy: boolean
  behavior: FollowUpBehavior
  /** Primary+Enter, or a Primary-click on send. */
  alternate: boolean
  /** The transport and the chat's provider take a message mid-turn. */
  canSteer: boolean
  /** The turn can be acted on now (`queuedTurnSendNow` is not disabled, and the chat may be driven). */
  sendNowAvailable: boolean
}): ComposerDispatch {
  if (!input.busy) return 'send'
  if (!input.sendNowAvailable) return 'queue'
  if (!input.canSteer) return input.alternate ? 'stop-and-send' : 'queue'
  const chosen: FollowUpAction = input.behavior
  if (!input.alternate) return chosen
  return chosen === 'steer' ? 'queue' : 'steer'
}

const LABELS: Record<FollowUpAction, string> = {
  queue: 'Queue message',
  steer: 'Steer message',
  'stop-and-send': 'Stop and send',
}

const VERBS: Record<FollowUpAction, string> = {
  queue: 'queue',
  steer: 'steer',
  'stop-and-send': 'stop and send',
}

export type FollowUpSendPresentation = {
  /** What a plain click (and Enter) does. */
  action: FollowUpAction
  /** What a Primary-click (and Primary+Enter) does. The same as `action` where there is no choice. */
  alternate: FollowUpAction
  /** The button's accessible name for an action. */
  labels: Record<FollowUpAction, string>
  tooltip: string
}

/**
 * The send button while the agent works: its action, the one a Primary-click
 * takes instead, and a tooltip that names both and the chords for the other.
 */
export function followUpSendPresentation(input: {
  behavior: FollowUpBehavior
  canSteer: boolean
  sendNowAvailable: boolean
  /** Why the turn cannot be acted on now, where it cannot. */
  unavailableReason?: string
  /** The platform's Primary key as a click modifier: `⌘` or `Ctrl`. */
  clickModifier: string
  /** Primary+Enter as the platform writes it. */
  shortcutLabel: string
}): FollowUpSendPresentation {
  const resolve = (alternate: boolean) =>
    resolveComposerDispatch({
      busy: true,
      behavior: input.behavior,
      alternate,
      canSteer: input.canSteer,
      sendNowAvailable: input.sendNowAvailable,
    }) as FollowUpAction
  const action = resolve(false)
  const alternate = resolve(true)
  const tooltip =
    action === alternate
      ? ['Queue: it goes when this turn ends.', input.unavailableReason].filter(Boolean).join(' ')
      : `Click to ${VERBS[action]}, ${input.clickModifier}-click or ${input.shortcutLabel} to ${VERBS[alternate]}`
  return { action, alternate, labels: LABELS, tooltip }
}

/** The platform's Primary key as a click modifier. */
export function primaryClickModifier(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl'
}
