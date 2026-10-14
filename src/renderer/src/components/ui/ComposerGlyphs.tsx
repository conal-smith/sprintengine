import React from 'react'

// The composer's own marks (owner ruling 2026-10-04): the "+" that opens the
// composer's options, the three "Start as" choices, the options' rows and the
// round send's arrow. 16-grid, stroke 1.4, line work in currentColor, sized
// and inked by the caller. The plain terminal's frame is `TerminalPromptGlyph`
// (ui/CodeBlockGlyphs), which is the same drawing, so it has no twin here.
//
// Spec: design-system/components/glyphs/component.md → "Composer".

type GlyphProps = { className?: string }

function Stroke({ d, className }: { d: string; className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The "+" that opens the composer's options. `glyphs/plus.svg`. */
export function ComposerPlusGlyph({ className }: GlyphProps): React.JSX.Element {
  return <Stroke className={className} d="M8 3.2v9.6M3.2 8h9.6" />
}

/** A chat: a speech bubble. "Start as Conversation". `glyphs/conversation.svg`. */
export function ConversationGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Stroke
      className={className}
      d="M2.6 4.1c0-.8.7-1.5 1.5-1.5h7.8c.8 0 1.5.7 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5H7.2l-3 2.4V11h-.1c-.8 0-1.5-.7-1.5-1.5Z"
    />
  )
}

/**
 * A terminal frame with a prompt and a small plus of activity in its corner:
 * a CLI agent running in a terminal. "Start as Terminal agent".
 * `glyphs/terminal-agent.svg`.
 */
export function TerminalAgentGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.8 6.4 6.6 8l-1.8 1.6M11.2 5.4v2.6M9.9 6.7h2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A paper clip: attach files. `glyphs/attach.svg`. */
export function AttachGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <Stroke
      className={className}
      d="M10.6 5.6 6.4 9.8a1.3 1.3 0 0 0 1.8 1.8l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.4 8a3.9 3.9 0 0 0 5.5 5.5l3.4-3.4"
    />
  )
}

/** A puzzle piece: skills, plugins and MCP servers. `glyphs/plugins.svg`. */
export function PluginsGlyph({ className }: GlyphProps): React.JSX.Element {
  return <Stroke className={className} d="M3 5.4h2.4a1.4 1.4 0 1 1 2.8 0h2.4v2.4a1.4 1.4 0 1 1 0 2.8V13H3Z" />
}

/** An arrow up: the round send. `glyphs/send.svg`. */
export function SendGlyph({ className }: GlyphProps): React.JSX.Element {
  return <Stroke className={className} d="M8 12.8V3.6M4.3 7.3 8 3.6l3.7 3.7" />
}

/**
 * A list with a plus: the round send while the agent works, when the message
 * waits for the turn's end. `glyphs/queue.svg`.
 */
export function QueueGlyph({ className }: GlyphProps): React.JSX.Element {
  return <Stroke className={className} d="M2.8 4.2h7.4M2.8 8h7.4M2.8 11.8h4.4M11.8 9.6v4.4M9.6 11.8H14" />
}

/**
 * An arrow turning up and on: the round send while the agent works, when the
 * message goes into the running turn. `glyphs/steer.svg`.
 */
export function SteerGlyph({ className }: GlyphProps): React.JSX.Element {
  return <Stroke className={className} d="M3.6 12.8V9.4a3 3 0 0 1 3-3h6.2M9.6 3.2l3.2 3.2-3.2 3.2" />
}

/**
 * A folder holding a commit node: a checkout in its own directory. The Git
 * panel's Worktrees view, and the composer strip's Worktree switch.
 * `glyphs/worktree.svg`.
 */
export function WorktreeGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <path
        d="M1.75 4.75c0-.83.67-1.5 1.5-1.5h3.1l1.5 1.5h5.4c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="9.6" r="1.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.25 9.6h2.5M9.25 9.6h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
