// Imported from the concrete module rather than the `../../ui` barrel to keep
// this hookless module free of the barrel's whole component graph.
import type React from 'react'
import { MenuOption } from '../../ui/MenuOption'
import { LockGlyph, PresetDialGlyph, RuleShieldGlyph, SparkGlyph, UnlockedGlyph } from '../../AppIcons'
import { EditChangelistGlyph } from '../../ui/GitActionGlyphs'
import type { CliPermissionPreset } from '../../../types/workspace'
import type { CliPermissionModeSpec } from '../../../../../shared/cli-permission-mode'

// Shared, presentation-only pieces of the agent spawn surfaces (the compact
// SpawnPicker and the New Chat panel). Kept in one hookless module so every
// surface can import them without pulling in the composer's store hook.

/**
 * One row of a permission menu: one of the CLI's modes, under its own name
 * (owner request 2026-10-01). `value` is the preset it sits at, which is what
 * every launch and every check reads; `mode` is the CLI's own id for a mode
 * that is not a preset's own (Claude Code's Accept edits), which rides beside
 * it.
 */
export type PermissionModeOption = {
  /** The row's key: the mode's id, which for a preset's own mode is the preset. */
  id: string
  value: CliPermissionPreset
  mode?: string
  label: string
  /** One line for a menu row's meta — the row has 280px, not a paragraph. */
  summary: string
  /** The full explanation, for a tooltip. */
  title: string
}

// The four presets in the app's own words, for a CLI whose manifest the
// catalog has not listed (and the summary or tooltip a manifest leaves out).
// Strictest first and No flag, which asks whatever the CLI is configured to,
// last; Auto is what a launch nobody chose for runs (owner request
// 2026-10-01).
export const AGENT_SPAWN_PERMISSION_OPTIONS: PermissionModeOption[] = [
  {
    id: 'manual',
    value: 'manual',
    label: 'Manual',
    summary: 'Asks before every edit and command.',
    title:
      'Ask before every action that changes something or reaches out: each edit, command, web request and MCP tool. Reading and searching the workspace does not ask.',
  },
  {
    id: 'auto',
    value: 'auto',
    label: 'Auto',
    summary: 'Edits go through; commands and the rest ask.',
    title:
      'Read and edit files in the workspace without asking, and in a chat use your connected MCP tools too. Commands, web access and anything outside the workspace ask first.',
  },
  {
    id: 'bypass',
    value: 'bypass',
    label: 'Bypass permissions',
    summary: 'Skip every prompt. Trusted repos only.',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
  {
    id: 'none',
    value: 'none',
    label: 'No flag',
    summary: 'The CLI’s default — no permission flag is passed.',
    title:
      'Pass no permission flag, so the agent runs on its own configured permissions. That can mean asking for approval, or not.',
  },
]

// Chip-width labels for a preset the CLI's own list does not name. Exhaustive
// over the union so a preset added later fails the build here rather than
// rendering a blank chip.
export const PRESET_CHIP_LABEL: Record<CliPermissionPreset, string> = {
  none: 'No flag',
  manual: 'Manual',
  auto: 'Auto',
  bypass: 'Bypass',
}

const GENERIC_OPTION = Object.fromEntries(
  AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => [option.value, option]),
) as Record<CliPermissionPreset, PermissionModeOption>

/**
 * The rows a permission menu lists for a CLI: its modes as its manifest names
 * them (`PluginRegistryListEntry.permissionModes`), in the manifest's order,
 * or the four presets in the app's words when there is no list. Stored values
 * stay the preset, plus the CLI's own id for a mode that is not a preset's own.
 *
 * A read-only mode of a CLI's own (Cursor's Ask, Claude Code's Plan) is left
 * out: it is for an agent launching another by name. A row here is remembered
 * as the CLI's preset, and Cursor's chats refuse the Manual that Ask sits at.
 */
export function agentPermissionOptions(modes?: readonly CliPermissionModeSpec[] | null): PermissionModeOption[] {
  if (!modes?.length) return AGENT_SPAWN_PERMISSION_OPTIONS
  const offered = modes.filter((spec) => !spec.readOnly || spec.id === spec.level)
  return offered.map((spec) => ({
    id: spec.id,
    value: spec.level,
    ...(spec.id !== spec.level ? { mode: spec.id } : {}),
    label: spec.label,
    summary: spec.summary ?? GENERIC_OPTION[spec.level].summary,
    title: spec.description ?? GENERIC_OPTION[spec.level].title,
  }))
}

/**
 * The row a preset, and the CLI's own mode beside it, select: that mode when
 * the list has it at that preset, else the preset's own mode, else null (a
 * preset this CLI has no mode for).
 */
export function selectedPermissionOption(
  options: readonly PermissionModeOption[],
  preset: CliPermissionPreset,
  mode?: string | null,
): PermissionModeOption | null {
  return (
    (mode ? options.find((option) => option.mode === mode && option.value === preset) : undefined) ??
    options.find((option) => option.id === preset && !option.mode) ??
    null
  )
}

/** The chip's word for a preset and mode: the mode's own name, else the preset's. */
export function agentPermissionChipLabel(
  options: readonly PermissionModeOption[],
  preset: CliPermissionPreset,
  mode?: string | null,
): string {
  return selectedPermissionOption(options, preset, mode)?.label ?? PRESET_CHIP_LABEL[preset]
}
// One glyph per preset, a vocabulary that reads at a glance, drawn once in
// AppIcons: an open lock for Bypass, a spark for Auto, a closed lock for
// Manual, a quiet dial for the CLI's own default. All-or-nothing per the menu
// spec's leading-slot rule — every row carries one.
//
// A CLI's own mode that sits at a preset beside that preset's own mode takes a
// glyph of its own, or a menu listing both draws two rows with one mark: a
// pencil for Accept edits (edits go through, commands ask) beside Auto's
// spark, a shield for Don't ask (never asks, held to the allow rules) beside
// Manual's lock.
const MODE_GLYPH: Record<string, (props: { className?: string }) => React.JSX.Element> = {
  acceptEdits: EditChangelistGlyph,
  dontAsk: RuleShieldGlyph,
}

export function PresetGlyph({
  preset,
  mode,
  className = 'icon-xs shrink-0',
}: {
  preset: CliPermissionPreset
  /** The CLI's own mode at that preset, when it is not the preset's own. */
  mode?: string | null
  className?: string
}) {
  const ModeGlyph = mode ? MODE_GLYPH[mode] : undefined
  if (ModeGlyph) return <ModeGlyph className={className} />
  if (preset === 'bypass') return <UnlockedGlyph className={className} />
  if (preset === 'auto') return <SparkGlyph className={className} />
  if (preset === 'manual') return <LockGlyph className={className} />
  return <PresetDialGlyph className={className} />
}

const PRESET_ROW_SELECTOR = '[data-preset-option="true"]'

/**
 * Land focus on the checked preset row when a host opens the menu — the
 * surface is portaled to <body>, so Tab from the trigger would never reach the
 * rows. Shared by the chat composer's pill and the launch panel's pill through
 * `Popover`'s `onOpenAutoFocus`. Popover paints its surface `visibility:
 * hidden` until measured and a hidden element cannot take focus, so the call
 * retries on the next frame once the surface is visible (only jsdom focuses a
 * hidden element, which is why a passing unit test could not see this).
 */
export function focusActivePresetRow(surface: HTMLElement): void {
  const rows = Array.from(surface.querySelectorAll<HTMLButtonElement>(PRESET_ROW_SELECTOR))
  const target =
    rows.find((row) => row.getAttribute('aria-checked') === 'true' && !row.disabled) ??
    rows.find((row) => !row.disabled)
  if (!target) return
  target.focus()
  if (document.activeElement === target) return
  requestAnimationFrame(() => {
    if (surface.isConnected) target.focus()
  })
}

/**
 * The menu spec's keyboard contract for a list of `menuitemradio` rows
 * (design-system/components/menu, "Accessibility"): ArrowUp/ArrowDown move and
 * wrap, Home/End jump to the ends, disabled rows are skipped so the walk only
 * lands on rows that do something, and Enter/Space activate the row under
 * focus. Escape is left alone — the Popover listens for it on `document` and
 * returns focus to the trigger. Every other key stops here: the surface is
 * portaled, but React bubbles through the REACT tree, which can run back
 * through a host row that treats Enter as "select me".
 *
 * Rows are found by `selector` inside `surface` (the closest `[role="menu"]`
 * to the row), so any host list of radio rows can adopt the contract by
 * spelling the selector on its rows and calling this from `onKeyDown`.
 */
export function menuRadioRowKeyDown(
  event: React.KeyboardEvent<HTMLButtonElement>,
  selector: string,
  activate: () => void,
): void {
  if (event.key === 'Escape') return
  event.stopPropagation()
  const current = event.currentTarget
  const surface = current.closest<HTMLElement>('[role="menu"]') ?? current.parentElement
  const rows = Array.from(surface?.querySelectorAll<HTMLButtonElement>(selector) ?? []).filter((row) => !row.disabled)
  const index = rows.indexOf(current)
  const focusAt = (next: number): void => {
    if (rows.length === 0) return
    rows[((next % rows.length) + rows.length) % rows.length]?.focus()
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusAt(index + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusAt(index - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    focusAt(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    focusAt(rows.length - 1)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!current.disabled) activate()
  }
}

// The permission choice as the menu spec's STACKED items — glyph on the first
// line, `body` name, one-line `meta` summary — shared by the chat composer's
// pill and the launch panel's pill so one choice never renders two ways
// (remote-sessions-ux / selector-menus-premium; the chip row above stays the
// compact in-line form for footers). Selection is `bg.selected` + a check,
// distinct from hover; Bypass keeps warn INK, never a fill.
//
// Roving tabIndex: the checked row is the tab stop, arrows move (the contract
// above). A row in `disabledReasons` stays listed and dimmed with its reason
// as the meta line — a control that vanishes when unavailable teaches nothing.
export function PermissionPresetMenuRows({
  options = AGENT_SPAWN_PERMISSION_OPTIONS,
  value,
  mode,
  disabled = false,
  disabledReasons,
  onSelect,
}: {
  /** The CLI's modes (`agentPermissionOptions`); the four presets when absent. */
  options?: readonly PermissionModeOption[]
  value: CliPermissionPreset
  /** The CLI's own mode chosen at `value`, when it is not the preset's own. */
  mode?: string | null
  /** Locks the rows while a live change is in flight. */
  disabled?: boolean
  /** Rows a target cannot take, by row id, each with the one-line reason it shows. */
  disabledReasons?: Partial<Record<string, string>>
  onSelect: (option: PermissionModeOption) => void
}) {
  const selected = selectedPermissionOption(options, value, mode)
  return (
    <>
      {options.map((option) => {
        const active = option === selected
        const isBypass = option.value === 'bypass'
        const reason = disabledReasons?.[option.id] ?? null
        const rowDisabled = disabled || reason !== null
        return (
          // The kit's value row in its stacked shape. Bypass's warn ink moves
          // onto the row's OWN title span rather than staying on the button: as
          // a caller className it met the primitive's resting and selected inks
          // at equal specificity, and which one painted was stylesheet order.
          <MenuOption
            key={option.id}
            role="menuitemradio"
            selected={active}
            stacked
            data-preset-option="true"
            tabIndex={active ? 0 : -1}
            disabled={rowDisabled}
            onKeyDown={(event) => menuRadioRowKeyDown(event, PRESET_ROW_SELECTOR, () => onSelect(option))}
            onClick={() => onSelect(option)}
            icon={
              <span className="mt-0.5 inline-flex shrink-0">
                <PresetGlyph preset={option.value} mode={option.mode} />
              </span>
            }
            trailing={
              active ? (
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className="mt-0.5 icon-xs shrink-0 text-[color:var(--accent-primary)]"
                >
                  <path
                    d="M3.5 8.5L6.5 11.5L12.5 4.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null
            }
          >
            <span
              className={`flex items-center gap-1.5 text-body font-medium ${
                isBypass ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-strong)]'
              }`}
            >
              <span className="min-w-0 truncate">{option.label}</span>
            </span>
            <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">
              {reason ?? option.summary}
            </span>
          </MenuOption>
        )
      })}
    </>
  )
}

// Terminal glyph for the Terminal quick row. Exported so the top bar's session
// list can reuse the same mark for terminal sessions.
export function TerminalSessionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7.25 10L10 12.5L7.25 15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.5 15H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The caret a toolbar chip that opens a menu ends on: the engine, machine and
 * project chips of the New chat composer, which have to read as one set.
 */
export function ChipCaretGlyph() {
  return (
    // No `shrink-0`: a sized glyph never shrinks below its width in a flex row
    // anyway, and `icon-xs shrink-0` is how the strip's checks recognise a
    // machine's mark, which this is not.
    <svg className="icon-xs text-[color:var(--text-subtle)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m4 6.5 4 3.5 4-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
