import type { JSX } from 'react'

// "An agent is using this", drawn the same everywhere it is said: on a tab
// (the pill), around the surface the tab shows (the edge), in the violet the
// Files tree marks a file an agent is reading or editing with
// (design-system/components/file-tree/component.md, "Agent trail"). A page an
// agent drives, a board it draws on and a file it edits are one state, so they
// wear one drawing.
//
// Both are decoration: the tab or surface that wears them says the state in
// its own accessible name.

/** The pill after a tab's label: the word, in the agent violet. */
export function AgentPill({ label = 'Agent' }: { label?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-agent-pill=""
      className="shrink-0 rounded-full bg-[color:var(--agent-trail-soft-strong)] px-1.5 text-micro leading-4 text-[color:var(--agent-trail-ink)]"
    >
      {label}
    </span>
  )
}

/**
 * The edge round a surface an agent is using. Place it as the last child of a
 * positioned surface: it fills that box, follows its radius, and takes no
 * pointer, so the surface under it stays usable. A later sibling of a
 * `<webview>` paints over the guest, so a page is framed, not covered.
 *
 * Still, never animated: unlike the working edge, it can stay up for as long
 * as an agent works, and a light lapping the page all that time is noise.
 */
export function AgentEdge(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-agent-edge=""
      className="pointer-events-none absolute inset-0 z-[var(--z-pane)] rounded-[inherit] ring-2 ring-inset ring-[color:var(--agent-trail-ink)]"
    />
  )
}

/** The violet outline of a tab whose surface an agent is using. No radius: it follows the tab's own. */
export const AGENT_TAB_RING_CLASS = 'ring-1 ring-inset ring-[color:var(--agent-trail-ink)]'

/**
 * The outline and the violet wash, for a tab with no fill of its own. A tab
 * whose selection is a fill keeps that fill and takes the outline alone:
 * two fills on one element are decided by stylesheet order, not by intent.
 */
export const AGENT_TAB_CLASS = `bg-[color:var(--agent-trail-soft)] ${AGENT_TAB_RING_CLASS}`
