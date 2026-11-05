import type { JSX } from 'react'

import {
  AppearanceSettingsIcon,
  CheckIcon,
  ExtensionsGlyph,
  GitBranchGlyph,
  PresetDialGlyph,
  ReleaseNotesIcon,
  RuleShieldGlyph,
  TrackersSettingsIcon,
} from '../../AppIcons'
import { CardButton } from '../../ui'
import type { ExtensionIdea } from './extensionIdeas'
import type { SuggestionCategory, SuggestionEntry } from './suggestionBank'

// The tiles under New chat's box: a suggested task that starts at a press, and
// an idea that fills the box in extension mode.

// Each kind of task has its own mark, so a row of them reads at a glance.
const CATEGORY_GLYPH: Record<SuggestionCategory, (props: { className?: string }) => JSX.Element> = {
  review: GitBranchGlyph,
  design: AppearanceSettingsIcon,
  performance: PresetDialGlyph,
  security: RuleShieldGlyph,
  tests: CheckIcon,
  backlog: TrackersSettingsIcon,
  docs: ReleaseNotesIcon,
  deps: ExtensionsGlyph,
}

export function SuggestionCard({
  entry,
  disabled,
  onLaunch,
}: {
  entry: SuggestionEntry
  disabled: boolean
  onLaunch: () => void
}) {
  const Glyph = CATEGORY_GLYPH[entry.category]
  return (
    // The kit's tile: a block button whose content is a composition rather than
    // a label. `raised` keeps the hairline at rest, so hover moves the ground
    // and nothing else — a row that reflows under the pointer is the defect
    // the tile spec rules out, and its ground is what lifts it off the page.
    // The inset stays with the caller, because a tile's padding is a composition
    // decision — and so does the radius: `radius.composer-companion`, so the
    // tiles read as one set with the composer above them rather than as ramp
    // cards parked beside it. The tile is the button: "Try" says what a press
    // does, last in reading order, so the title leads its accessible name.
    <CardButton
      variant="raised"
      onClick={onLaunch}
      disabled={disabled}
      className="relative h-full w-full rounded-[var(--sem-radius-composer-companion)] px-4 py-3"
    >
      <Glyph className="icon-sm text-[color:var(--text-muted)]" />
      <div className="mt-3 text-body font-medium text-[color:var(--text-strong)]">{entry.title}</div>
      <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{entry.description}</p>
      <span className="mt-auto pt-2 text-micro text-[color:var(--text-subtle)]">{entry.outcome}</span>
      <span className="absolute right-3 top-3 inline-flex h-control-xs items-center rounded-full border border-[color:var(--border-default)] px-2.5 text-meta text-[color:var(--text-default)]">
        Try
      </span>
    </CardButton>
  )
}

export function ExtensionIdeaCard({ idea, onPick }: { idea: ExtensionIdea; onPick: () => void }) {
  return (
    // The suggestion tile's shape; the surface it adds leads, because the cards
    // together are a map of what an extension can be.
    <CardButton
      variant="bordered"
      onClick={onPick}
      className="rounded-[var(--sem-radius-composer-companion)] px-3 py-2.5"
    >
      <span className="text-micro text-[color:var(--text-subtle)]">{idea.surface}</span>
      <div className="mt-0.5 text-body font-medium text-[color:var(--text-strong)]">{idea.title}</div>
      <p className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">{idea.description}</p>
    </CardButton>
  )
}
