import React from 'react'

// The square that stops work in a chat: the composer's Stop for the turn, and
// a running agent's lane's Stop for that agent alone. One drawing, so the two
// read as the same act at two sizes.
export function StopGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="8" height="8" rx="1.6" fill="currentColor" />
    </svg>
  )
}
