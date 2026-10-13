// The round send while the agent works: it queues the message or steers the
// running turn with it, as the person's choice says, and a Primary-click does
// the other (followUpDispatch.ts). Holding Primary turns the button to what a
// click would then do, so the click is never a guess. The held key is tracked
// here, in the button alone, so pressing it re-renders nothing else.

import React, { useEffect, useRef, useState } from 'react'

import { QueueGlyph, SendButton, SteerGlyph, SendGlyph, Tooltip } from '../../ui'
import type { FollowUpAction, FollowUpSendPresentation } from './followUpDispatch'

function usePrimaryHeld(primary: 'metaKey' | 'ctrlKey'): boolean {
  const [held, setHeld] = useState(false)
  // Told only when the key's state moves: every other key typed into the
  // composer passes through here, and asks nothing of React.
  const heldRef = useRef(false)
  useEffect(() => {
    const set = (next: boolean) => {
      if (heldRef.current === next) return
      heldRef.current = next
      setHeld(next)
    }
    const read = (event: KeyboardEvent) => set(event[primary])
    // A window left with the key down never hears it come up.
    const release = () => set(false)
    window.addEventListener('keydown', read)
    window.addEventListener('keyup', read)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', read)
      window.removeEventListener('keyup', read)
      window.removeEventListener('blur', release)
    }
  }, [primary])
  return held
}

function ActionGlyph({ action }: { action: FollowUpAction }): React.JSX.Element {
  if (action === 'steer') return <SteerGlyph className="icon-sm shrink-0" />
  if (action === 'queue') return <QueueGlyph className="icon-sm shrink-0" />
  return <SendGlyph className="icon-sm shrink-0" />
}

export function FollowUpSendButton({
  presentation,
  platform,
  disabled,
  onSend,
}: {
  presentation: FollowUpSendPresentation
  platform: string | undefined
  disabled: boolean
  /** `alternate`: the click was a Primary-click. */
  onSend: (alternate: boolean) => void
}): React.JSX.Element {
  const held = usePrimaryHeld(platform === 'darwin' ? 'metaKey' : 'ctrlKey')
  const action = held ? presentation.alternate : presentation.action
  return (
    <Tooltip content={presentation.tooltip} placement="top">
      <SendButton
        size="sm"
        aria-label={presentation.labels[action]}
        aria-keyshortcuts="Enter"
        data-composer-follow-up={action}
        disabled={disabled}
        onClick={(event) => onSend(event.metaKey || event.ctrlKey)}
        className="w-control-sm shrink-0"
      >
        <ActionGlyph action={action} />
      </SendButton>
    </Tooltip>
  )
}
