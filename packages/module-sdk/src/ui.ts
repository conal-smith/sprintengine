// `@sprintengine/module-sdk/ui` — the host-provided UI kit.
//
// TYPES ONLY AT RUNTIME. The host supplies the real components through an
// import map when it evaluates a third-party renderer bundle (see the app's
// src/renderer/src/modules/{third-party-loader,sdk-ui}.ts), so this module
// exists to give an author's bundler something to typecheck against and a
// loud failure if the specifier is not marked external. Evaluating it throws.
//
// esbuild:
//   --external:@sprintengine/module-sdk/ui
//
// The shapes below are restated by hand — the SDK cannot import app source —
// and are pinned against the app's components by the drift guard
// (packages/module-sdk/drift/sdk-drift-guard.ts), which asserts both that
// every SDK prop type is accepted by the real component and, where the
// restatement is verbatim, that the two are identical.
//
// A note on styling: these components carry Tailwind utility classes and the
// app's design tokens (CSS custom properties). The tokens come from the host
// stylesheet, but the UTILITIES do not — the app's Tailwind build only scans
// app source, so a class first used inside a module compiles to nothing. A
// module that writes its own Tailwind classes must ship its own
// utilities-only stylesheet.

import type * as React from 'react'

import type { ModuleChatRuntimeOption } from './conversation.js'

const HOST_PROVIDED_MESSAGE =
  '@sprintengine/module-sdk/ui is provided by the host at runtime; mark it external in your bundler'

function hostProvided(): never {
  throw new Error(HOST_PROVIDED_MESSAGE)
}

// ── Shared vocabulary ────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'error'

/** `Tone` plus the one status-only colour that is not a tone anywhere else. */
export type StatusTone = Tone | 'merged'

export type LifecycleState =
  'todo' | 'idea' | 'ready' | 'blocked' | 'in_progress' | 'paused' | 'needs_input' | 'done' | 'archived' | 'failed'

export type SelectItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
  tone?: Tone
}

export type SegmentedControlItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
  icon?: React.ReactNode
  tooltip?: string
  /**
   * A named count trailing the label — how much is waiting behind this choice
   * (the badge component's count species). `label` joins the segment's
   * accessible name. Ignored on an `iconOnly` strip; null or 0 draws nothing.
   */
  badge?: { count: number; label: string; tone?: Tone } | null
}

export type FilterMenuGroup = {
  label: string
  items: ReadonlyArray<SelectItem<string>>
  value: string
  defaultValue: string
  onChange: (value: string) => void
}

/** The tooltip-wiring props a kit glyph forwards to its host element. */
export type TooltipChildProps = {
  'aria-describedby'?: string
  onMouseEnter?: (event: React.MouseEvent) => void
  onMouseLeave?: (event: React.MouseEvent) => void
  onFocus?: (event: React.FocusEvent) => void
  onBlur?: (event: React.FocusEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
  onPointerDown?: (event: React.PointerEvent) => void
}

/** The one focus ring. Compose it onto any custom focusable a module draws. */
export const FOCUS_RING_CLASS: string = hostProvided()

// ── Buttons ──────────────────────────────────────────────────────────────────

export type ButtonBase = React.ButtonHTMLAttributes<HTMLButtonElement>

export type ButtonAlign = 'center' | 'start' | 'end'
export type ButtonSize = 'inline' | 'xs' | 'sm' | 'md'
export type ButtonTone = 'neutral' | 'danger'
export type GhostTone = ButtonTone | 'quiet' | 'subtle' | 'strong' | 'accent' | 'ink'

export type SizedButtonProps = ButtonBase & {
  size?: ButtonSize
  align?: ButtonAlign
  busy?: boolean
}

export type PrimaryButtonProps = SizedButtonProps
export type GhostButtonProps = SizedButtonProps & {
  tone?: GhostTone
  pressed?: boolean
  armed?: boolean
}
export type OutlineButtonProps = SizedButtonProps & {
  tone?: ButtonTone
  pressed?: boolean
}

export type ButtonComponent<P> = React.ForwardRefExoticComponent<
  React.PropsWithoutRef<P> & React.RefAttributes<HTMLButtonElement>
>

/** The one affirmative action on a surface. */
export const PrimaryButton: ButtonComponent<PrimaryButtonProps> = hostProvided()
/** The default button everywhere else. */
export const GhostButton: ButtonComponent<GhostButtonProps> = hostProvided()
/** A bordered button for a secondary action beside a primary one. */
export const OutlineButton: ButtonComponent<OutlineButtonProps> = hostProvided()

/**
 * `accent` (default) for an action set in a sentence; `quiet` for a disclosure
 * ("More"); `name` for a row's name that opens its own details — title ink,
 * underlined on hover, so a list of names is not a list of accents.
 */
export type LinkInk = 'accent' | 'quiet' | 'name'
export type LinkUnderline = 'hover' | 'always' | 'never'
export type LinkLayout = 'inline' | 'row'

export type LinkButtonProps = ButtonBase & {
  ink?: LinkInk
  underline?: LinkUnderline
  layout?: LinkLayout
  size?: 'meta' | 'inherit'
}

/** A button that reads as a link — navigation, not commitment. */
export const LinkButton: ButtonComponent<LinkButtonProps> = hostProvided()

export type RowButtonDensity = 'row' | 'nav' | 'bleed' | 'flush'
export type RowButtonVariant = 'plain' | 'dashed'

export type RowButtonProps = ButtonBase & {
  density?: RowButtonDensity
  variant?: RowButtonVariant
  selected?: boolean
}

/** A full-width list row that behaves as a button. */
export const RowButton: ButtonComponent<RowButtonProps> = hostProvided()

// ── Inputs ───────────────────────────────────────────────────────────────────

export type InputSize = 'none' | 'xs' | 'sm' | 'content' | 'md'
export type InputVariant = 'default' | 'well' | 'quiet' | 'seamless' | 'composer' | 'inline'

export type SharedInputProps = {
  size?: InputSize
  variant?: InputVariant
  fullWidth?: boolean
}

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & SharedInputProps

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> &
  SharedInputProps & {
    resize?: 'y' | 'none'
  }

export const Input: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<InputProps> & React.RefAttributes<HTMLInputElement>
> = hostProvided()

export const Textarea: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<TextareaProps> & React.RefAttributes<HTMLTextAreaElement>
> = hostProvided()

/** The props a `Field` clones onto its single labelled child. */
export type FieldChildProps = {
  id?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'aria-required'?: boolean
}

export type FieldProps = {
  label: string
  /** Omit for a composite row: the label then renders as a span and nothing
   *  is cloned, and the caller owns the accessible name. */
  htmlFor?: string
  help?: string
  error?: string
  required?: boolean
  children: React.ReactElement<FieldChildProps>
  className?: string
}

export const Field: (props: FieldProps) => React.ReactElement = hostProvided()

/**
 * The trigger's step on the control-height ramp, under the names the buttons
 * and `Input` use, so a select stands level with the controls in its row: `sm`
 * (default, every labelled form field), `xs` (a dense toolbar of `xs` buttons,
 * meta type), `md` (beside an `md` button).
 */
export type SelectSize = 'xs' | 'sm' | 'md'

export type SelectProps<V extends string = string> = {
  ariaLabel: string
  items: SelectItem<V>[]
  value: V | null
  onChange: (value: V) => void
  /** The trigger height step. Defaults to `sm`. */
  size?: SelectSize
  disabled?: boolean
  placeholder?: string
  className?: string
  triggerMinWidthClassName?: string
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  'aria-required'?: boolean
}

/** One value out of a closed list: a select-only combobox with the full
 *  keyboard contract (arrows, Home/End, type-ahead, Escape). */
export const Select: <V extends string = string>(props: SelectProps<V>) => React.ReactElement = hostProvided()

export type DateTimeInputType = 'datetime-local' | 'date' | 'time'

export type DateTimeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> & {
  /** Which native control. Defaults to `datetime-local`. */
  type?: DateTimeInputType
  /** The control-ramp step, as on `Input`. Defaults to `sm`. */
  size?: 'xs' | 'sm' | 'md'
  /** The field ground, as on `Input`. */
  variant?: 'default' | 'well' | 'quiet'
  /** Fill the track (default). Pass `false` to size the field to its value. */
  fullWidth?: boolean
}

/**
 * A date, a time, or both: the platform's own `datetime-local` / `date` /
 * `time` control (keyboard-complete, locale-ordered, every segment named) in
 * the `Input` box, with tabular figures. Values are the native local-time
 * strings — `YYYY-MM-DDTHH:mm`, `YYYY-MM-DD`, `HH:mm` — never `Date`s, so the
 * time zone they mean stays your decision. Label it with `Field`.
 */
export const DateTimeInput: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<DateTimeInputProps> & React.RefAttributes<HTMLInputElement>
> = hostProvided()

export type ToggleProps = {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name. Required unless `ariaLabelledBy` is supplied. */
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string
  /** Stable id so a sibling `<label htmlFor>` or `Field` can target the control. */
  id?: string
  disabled?: boolean
  className?: string
}

/**
 * A setting that takes effect the moment it is thrown — the app's switch
 * (`role="switch"`; Space toggles, Enter does not). For a value submitted later
 * with a form, use a checkbox; for three or more choices, `SegmentedControl`.
 */
export const Toggle: (props: ToggleProps) => React.ReactElement = hostProvided()

export type SegmentedControlProps<V extends string = string> = {
  ariaLabel: string
  ariaDescribedBy?: string
  items: SegmentedControlItem<V>[]
  value: V
  onChange: (value: V) => void
  size?: 'sm' | 'md'
  iconOnly?: boolean
  className?: string
}

export const SegmentedControl: <V extends string = string>(props: SegmentedControlProps<V>) => React.ReactElement =
  hostProvided()

// ── Feedback ─────────────────────────────────────────────────────────────────

/** The host's standard panel heading. Tool identity is host-internal. */
export type PanelHeaderProps = {
  title: string
  titleId?: string
  leading?: React.ReactNode
  count?: number | string
  primaryAction?: React.ReactNode
  overflow?: React.ReactNode
  divider?: boolean
  progress?: { value: number; total: number; warnValue?: number; ariaLabel?: string }
} & ({ subtitle?: string; scope?: never } | { subtitle?: never; scope?: React.ReactNode })

export const PanelHeader: (props: PanelHeaderProps) => React.ReactElement = hostProvided()

export type BannerProps = {
  tone: 'error' | 'warn'
  message: string
  onRetry?: () => void
  retryLabel?: string
  /** One extra recovery control beside the retry. */
  action?: React.ReactNode
}

/** Panel-spanning error/warn strip at the top of a content area. */
export const Banner: (props: BannerProps) => React.ReactElement = hostProvided()

export type InlineNoticeTone = 'error' | 'warn'

export type InlineNoticeProps = {
  tone: InlineNoticeTone
  title?: React.ReactNode
  hint?: React.ReactNode
  detail?: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

/** Inline-scoped advisory at the failure site. */
export const InlineNotice: (props: InlineNoticeProps) => React.ReactElement = hostProvided()

export type EmptyStateProps = {
  title: React.ReactNode
  body?: React.ReactNode
  glyph?: React.ReactNode
  action?: React.ReactNode
  /** `pane` (default) fills a region; `list` sits inside an empty list. */
  density?: 'pane' | 'list'
  className?: string
}

export const EmptyState: (props: EmptyStateProps) => React.ReactElement = hostProvided()

export type SpinnerProps = {
  size?: number
  /** Supply it and the spinner is announced; omit it and it is decorative. */
  label?: string
  className?: string
}

export const Spinner: (props: SpinnerProps) => React.ReactElement = hostProvided()

export type StatusDotProps = {
  tone: StatusTone
  pulse?: boolean
  label?: string
  size?: number
  className?: string
}

export const StatusDot: (props: StatusDotProps) => React.ReactElement = hostProvided()

export type LifecycleGlyphProps = {
  state: LifecycleState
  label?: string
  live?: boolean
  className?: string
  style?: React.CSSProperties
} & Partial<TooltipChildProps>

export const LifecycleGlyph: (props: LifecycleGlyphProps) => React.ReactElement = hostProvided()

// ── Structure ────────────────────────────────────────────────────────────────

export type SectionProps = {
  title?: string
  count?: number | string
  action?: React.ReactNode
  headingId?: string
  level?: 2 | 3 | 4
  /** `true` (default) pads the body, `false` leaves it to the body, `'flush'`
   *  drops the header inset too. */
  inset?: boolean | 'flush'
  className?: string
  children: React.ReactNode
}

export const Section: (props: SectionProps) => React.ReactElement = hostProvided()

export type DrawerProps = {
  open: boolean
  onClose: () => void
  title: string
  ariaLabel: string
  closeLabel?: string
  width?: number
  children: React.ReactNode
}

export type DrawerBodyProps = {
  children: React.ReactNode
  className?: string
}

export const Drawer: ((props: DrawerProps) => React.ReactElement) & {
  Body: (props: DrawerBodyProps) => React.ReactElement
} = hostProvided()

export type TruncatedTextTag = 'p' | 'div' | 'span' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

export type TruncatedTextProps = {
  text: string
  as?: TruncatedTextTag
  className?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  id?: string
  multiline?: boolean
}

/** Text that clamps and grows a tooltip only when it actually truncated. */
export const TruncatedText: (props: TruncatedTextProps) => React.ReactElement = hostProvided()

export type KeybindingPlatform = 'darwin' | 'windows' | 'linux'

export type KbdChordProps = {
  keys?: readonly string[]
  chord?: string
  platform?: KeybindingPlatform
  separator?: React.ReactNode
  ariaLabel?: string
  className?: string
}

export const KbdChord: (props: KbdChordProps) => React.ReactElement = hostProvided()

// ── Menus ────────────────────────────────────────────────────────────────────

export type ContextMenuProps = {
  /** Viewport x of the open point (e.g. `event.clientX` or a button corner). */
  x: number
  /** Viewport y of the open point. */
  y: number
  /** Required accessible name for the menu surface. */
  ariaLabel: string
  /** Called on Escape, on a pointer-down outside the menu, and is yours to call
   *  after an item runs. Unmount the menu in it. */
  onClose: () => void
  /** `MenuItem`s and `MenuDivider`s. */
  children: React.ReactNode
  /** Extra surface classes — typically a `min-w-[…]` floor. */
  surfaceClassName?: string
}

/**
 * A menu opened at a point — a right-click, or the corner of an overflow
 * button. Mount it while open and unmount it in `onClose`. It portals to the
 * document body, clamps itself inside the viewport, and takes focus as it
 * opens: ↑/↓ and Home/End move between items, Escape or a click outside
 * closes it, and focus returns to whatever had it before.
 */
export const ContextMenu: (props: ContextMenuProps) => React.ReactElement = hostProvided()

export type MenuItemProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onClick' | 'role' | 'aria-checked' | 'type' | 'children'
> & {
  children: React.ReactNode
  /** Run the action. The menu does not close itself: call your `onClose`. */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** E.g. open a secondary picker at the pointer; the menu stays open. */
  onContextMenu?: (event: React.MouseEvent) => void
  /** Leading glyph; size and color stay with the caller's node. */
  icon?: React.ReactNode
  /** Visible keyboard shortcut hint (e.g. `F2`). Display only. */
  shortcut?: string
  /** A quiet trailing annotation (how long ago, how many) — never beside a
   *  `shortcut`; a row states one or the other. */
  hint?: React.ReactNode
  /** Destructive: drawn in the error ink, never a fill. */
  variant?: 'danger'
  disabled?: boolean
  /** When set, the item is checkable and exposes this checked state. The
   *  visible check mark is yours — pass it as `icon` or `trailing`. */
  checked?: boolean
  /** `single` (default): independent toggles. `one-of`: exactly one of a set,
   *  announced as a radio item. */
  selection?: 'single' | 'one-of'
  /** Trailing node, after the shortcut. */
  trailing?: React.ReactNode
  /** For a host menu with its own roving focus. `ContextMenu` needs none. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  /** The row opens a sub-surface and says so. */
  expanded?: boolean
}

/** One row of a `ContextMenu`. Not a tab stop: the menu's arrow keys reach it. */
export const MenuItem: (props: MenuItemProps) => React.ReactElement = hostProvided()

/** The hairline between groups of `MenuItem`s (`role="separator"`). */
export const MenuDivider: () => React.ReactElement = hostProvided()

// ── Chips ────────────────────────────────────────────────────────────────────

export type ChipProps = {
  /** One tone, on purpose: a toned chip would be a status. */
  tone?: 'neutral'
  className?: string
  /** One or two words, sentence case. */
  children: React.ReactNode
}

/**
 * The static chip: a hairline rectangle holding one or two words of FACT about
 * the thing beside it ("Default", "Pinned", "v2"). No tone, no fill, no hover,
 * not focusable — a mark, never a control and never a status. For a chip that
 * toggles, filters or wears an identity colour, use `ChipButton`; for a count
 * or a state, use a badge or `LifecycleGlyph`.
 */
export const Chip: (props: ChipProps) => React.ReactElement = hostProvided()

/** `ghost` (default, no edge), `outline` (findable on a busy surface),
 *  `overlay` (floating over content), `raised` (a control in a toolbar row),
 *  `pill` (one of a line of filters over a gallery, resting on the well). */
export type ChipVariant = 'ghost' | 'outline' | 'overlay' | 'raised' | 'pill'

/** The chip's ink at rest: `subtle` (default), `neutral` (one step up), or a
 *  standing `warn` / `error` the chip itself carries. */
export type ChipTone = 'subtle' | 'neutral' | 'warn' | 'error'

export type ChipButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ChipVariant
  tone?: ChipTone
  /** A toggle that is currently ON. `undefined` on a chip that is not a toggle,
   *  `false` on one that is off. Supplies `aria-pressed`. */
  pressed?: boolean
  /** One of a set, and this is the one in force. Same fill as `pressed`,
   *  announced as `aria-current`. */
  selected?: boolean
  /** An IDENTITY colour (a label's, a bucket's): a CSS colour of your choosing, painted as the
   *  ink and a soft ground mixed from it — never a solid fill. Ignored while
   *  pressed or selected. */
  tint?: string
}

/**
 * The interactive chip: a content-height pill that toggles, filters or names
 * one thing, riding the line it sits in rather than setting its height.
 */
export const ChipButton: ButtonComponent<ChipButtonProps> = hostProvided()

// ── Boards ───────────────────────────────────────────────────────────────────

export type TaskCardProps = {
  /** The tone of the default leading status mark. */
  tone: Tone
  /** Pulse on the leading mark — only for something running right now. */
  pulse?: boolean
  /** Leading status mark. `undefined` keeps the default mark (tone + pulse);
   *  pass a node (a `LifecycleGlyph`) to replace it, or `null` for none — on a
   *  board whose lane already states the status. */
  leading?: React.ReactNode
  /** The record's key, in the mono identifier face. */
  identifier: React.ReactNode
  title: React.ReactNode
  /** One quiet line under the title. */
  supporting?: React.ReactNode
  /** Trailing slot (priority icon, role glyph). Display-only — must not hold
   *  interactive elements; the card itself is the interactive surface. */
  trailing?: React.ReactNode
  selected?: boolean
  /** `row` (default): identifier and title on one line, for a list. `card`:
   *  identifier above a title that clamps to two lines, for a board lane. */
  variant?: 'row' | 'card'
  /** `card` only: clamp the title to two lines (default). `false` wraps it in
   *  full — for thin lanes and descriptive titles. */
  clampTitle?: boolean
  /** Makes the card a button (Enter/Space activate, `aria-pressed` = selected). */
  onSelect?: () => void
  onContextMenu?: (event: React.MouseEvent<HTMLLIElement>) => void
  /** Drag-and-drop opt-in. When true, the card is a drag source. */
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLLIElement>) => void
  onDragEnd?: (event: React.DragEvent<HTMLLIElement>) => void
  /** The card's stable id, for the lane's reorder animation. */
  flipKey?: string
  /** The just-moved highlight: `card-just-moved` after a drag, or
   *  `card-just-moved-gold` for a card that moved on its own. */
  justMovedClassName?: string
  ariaLabel?: string
}

/**
 * A task as a list row or a board card — the app's canonical shape for one,
 * so a module's board reads like the app's own. It renders an `<li>`: put it
 * inside a `BoardLane` (or your own `<ul>`/`<ol>`).
 */
export const TaskCard: (props: TaskCardProps) => React.ReactElement = hostProvided()

/** A lane's drag state: `dimmed` (not a legal drop target), `legal-drop-target`
 *  (accent ring), `source` (the lane the card came from). */
export type BoardLaneState = 'default' | 'dimmed' | 'legal-drop-target' | 'source'

export type BoardLaneDnd = {
  /** Receives the drop index computed from the pointer over the lane's cards. */
  onDragOver: (dropIndex: number) => void
  onDragLeave: () => void
  onDrop: () => void
}

export type BoardLaneProps = {
  /** Sentence-case lane label. */
  label: string
  /** Optional leading glyph (a `LifecycleGlyph`). */
  glyph?: React.ReactNode
  /** Item count, shown beside the label. */
  count: number
  /** Accessible name for the lane. Defaults to `${label} lane`. */
  ariaLabel?: string
  /** Reorder signature, typically `ids.join(',')`: a change animates the cards
   *  to their new places. */
  flipKey: string
  /** Drag state. */
  state?: BoardLaneState
  /** Draw the lane as a filled, hairline-bordered panel and lift its cards one
   *  step. Off by default (transparent lanes on the board's canvas). */
  surface?: boolean
  /** Minimum lane width in px before the board scrolls. Defaults to 260. */
  minWidth?: number
  /** Drag-and-drop plumbing. Pass it only when the lane accepts drops. */
  dnd?: BoardLaneDnd
  /** The lane's `TaskCard`s, and its empty placeholder when there are none. */
  children: React.ReactNode
}

/**
 * One column of a board: a header (glyph, label, count) over a scrolling list
 * of `TaskCard`s that animates reorders, with optional drag-and-drop. Lanes
 * are `flex-1`; lay them out in a horizontal flex row.
 */
export const BoardLane: (props: BoardLaneProps) => React.ReactElement = hostProvided()

// ── Text ─────────────────────────────────────────────────────────────────────

/** What a web link in `SafeMarkdown` does: `open` it in the system browser,
 *  `copy` its address, or render it as plain text (`none`). */
export type SafeMarkdownLinks = 'open' | 'copy' | 'none'

export type SafeMarkdownProps = {
  /** The Markdown source. GitHub-flavoured: tables, task lists, alerts. */
  text: string
  /** What a web link does. Defaults to `open`. */
  links?: SafeMarkdownLinks
  /** One type step down, for Markdown inside a card. */
  compact?: boolean
  className?: string
}

/**
 * Agent-written Markdown, drawn the way the app's chat draws a reply, and
 * never able to reach outside its box: raw HTML shows as the escaped text it
 * is, a link keeps its address only when it is an absolute http(s) URL (every
 * other scheme renders as its label), and images are named, never fetched.
 * `links: 'open'` hands the URL to the system browser through the app's own
 * external-link path; the window never navigates.
 */
export const SafeMarkdown: (props: SafeMarkdownProps) => React.ReactElement = hostProvided()

// ── Navigation ───────────────────────────────────────────────────────────────

/** A row's unread count. Null or a zero count draws nothing — a badge never says 0. */
export type RowBadge = {
  count: number
  tone: Tone
  /** The count's full accessible name ("Plugins: 1 new"). */
  label: string
  /** The same without the place ("1 new"); a row already names its place, so
   *  this is what the badge announces when given. */
  detail?: string
}

export type SidebarNavButtonProps = {
  /** The sidebar is collapsed to its icon rail: draw the icon alone, with the
   *  label in a tooltip. */
  collapsed: boolean
  /** This row's door is the one showing. */
  active?: boolean
  label: string
  ariaLabel: string
  tooltip: string
  /** Show the tooltip while expanded too — for a hint the label omits. */
  tooltipWhenExpanded?: boolean
  /** A small state mark, trailing when expanded and in the corner when
   *  collapsed. Its own accessible name carries the meaning. */
  indicator?: React.ReactNode
  /** The row's unread count, drawn in place of `indicator` while above 0. */
  badge?: RowBadge | null
  /** `dashed` marks the one add/create affordance at the head of a rail. */
  variant?: RowButtonVariant
  disabled?: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  icon: React.ReactNode
}

/**
 * The sidebar's door row, exactly as the app's own doors draw it: a quiet
 * row that lights to the selected fill when active, an icon with a tooltip
 * when the sidebar is collapsed, and the unread `badge` the host derives for
 * it. Render it from your sidebar-nav entry so your door reads as native.
 */
export const SidebarNavButton: (props: SidebarNavButtonProps) => React.ReactElement = hostProvided()

// ── CLI / model picker ───────────────────────────────────────────────────────

/** A CLI runtime's id. Open by design: runtimes are plugin-contributed. */
export type AgentCli = string

export type PluginModelOption = { id: string; label?: string }
export type PluginReasoningOption = { id: string; label?: string }

export type PluginModelCatalog = {
  options: PluginModelOption[]
  allowCustomId: boolean
}

export type PluginReasoningCatalog = {
  levels: PluginReasoningOption[]
  default?: string
}

export type CliRuntimeOption = {
  value: AgentCli
  label: string
  modelSelection?: PluginModelCatalog
  reasoningSelection?: PluginReasoningCatalog
  hostedVia?: 'claude-code'
}

/** What the picker accepts: `host.listChatRuntimes()` rows as they come, or
 *  catalog rows of the older `{ value, label, modelSelection }` shape. */
export type CliRuntimePickerOption = CliRuntimeOption | ModuleChatRuntimeOption

export type CliModelPickerButtonProps = {
  ariaLabel: string
  /**
   * The runtimes to offer. Pass `host.listChatRuntimes()` straight in: each
   * runtime's `models` become its model list, and a runtime this machine lacks
   * (`available: false`) is left out unless it is the current `cli`. Catalog
   * rows (`CliRuntimeOption`) still work, and the two may be mixed.
   */
  options: ReadonlyArray<CliRuntimePickerOption>
  cli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
  disabled?: boolean
  /** Low-emphasis trigger for in-place property editing. */
  quiet?: boolean
  maxWidthClassName?: string
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
}

/**
 * The runtime + model trigger, so a module's agent controls read as the app's
 * own. Feed it `host.listChatRuntimes()` directly — no mapping — and hand the
 * chosen `cli` and model to `openChat`:
 *
 * ```tsx
 * const runtimes = host.listChatRuntimes()
 * <CliModelPickerButton
 *   ariaLabel="Agent"
 *   options={runtimes}
 *   cli={cli}
 *   effectiveModelFor={(id) => (id === cli ? model : undefined)}
 *   onSelectCli={setCli}
 *   onSelectModel={(id, next) => { setCli(id); setModel(next ?? undefined) }}
 * />
 * ```
 */
export const CliModelPickerButton: (props: CliModelPickerButtonProps) => React.ReactElement | null = hostProvided()
