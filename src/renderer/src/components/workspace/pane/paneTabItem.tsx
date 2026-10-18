import React from 'react'

import { browserTabLabel } from '../../../../../shared/browser'
import type { WorkspacePaneTab } from '../../../types/workspace'
import { OpenInWindowGlyph, TourGlyph, type TabItem } from '../../ui'
import { paneKindDefinition } from './paneKinds'

// One pane tab as a strip draws it. Two strips draw pane tabs — the pane's own,
// and a pop-out window's — and a tab has to read the same in both, so the
// label, the glyph slot and the accessible name are decided here once.

export function paneTabLabel(tab: WorkspacePaneTab): string {
  if (tab.kind === 'browser') return browserTabLabel(tab.url, tab.title)
  return tab.title?.trim() || paneKindDefinition(tab.kind).label
}

export function paneTabItem(
  tab: WorkspacePaneTab,
  options: { diffCount: number | null; agentPresent?: boolean },
): TabItem {
  const label = paneTabLabel(tab)
  const { Glyph } = paneKindDefinition(tab.kind)
  const tourOffered = tab.kind === 'diff' && Boolean(tab.diff?.tourOffer)
  // Out in a window of its own, the tab wears the pop-out mark in its glyph
  // slot — the drawing on the control that sent it there — and says so in its
  // name. Neither a dot nor a second badge: the strip has a slot for "what
  // this tab is like right now", and this is the one thing about it that is.
  const poppedOut = Boolean(tab.poppedOut)
  // An agent driving the page or drawing on the board (agentPresence.ts). A
  // popped-out tab says so in its own window, where the page is; here it is
  // only a pointer to that window.
  const agent = Boolean(options.agentPresent) && !poppedOut
  return {
    id: tab.id,
    label,
    closeLabel: `Close ${label}`,
    ...(tab.kind === 'diff' && options.diffCount !== null && !poppedOut ? { count: options.diffCount } : {}),
    // An agent wrote a tour and docked this tab with it. The strip draws no
    // corner count on a closable tab (its close glyph owns that corner), so
    // the tab wears the tour mark in its glyph slot instead, in the accent
    // ink a live mark may take, and says so in its name. Nothing moves until
    // the owner looks.
    ...(agent ? { agent: true } : {}),
    ...(poppedOut
      ? { ariaLabel: `${label}: shown in a separate window` }
      : agent
        ? { ariaLabel: `${label}: an agent is using this` }
        : tourOffered
          ? { ariaLabel: `${label}: a tour is ready` }
          : {}),
    icon: poppedOut ? (
      <OpenInWindowGlyph className="size-icon-xs shrink-0" />
    ) : tab.faviconUrl ? (
      <img src={tab.faviconUrl} alt="" className="size-icon-xs shrink-0 rounded-[3px]" />
    ) : tourOffered ? (
      <TourGlyph className="size-icon-xs shrink-0 text-[color:var(--accent-primary)]" />
    ) : (
      <Glyph className="size-icon-xs shrink-0" />
    ),
  }
}
