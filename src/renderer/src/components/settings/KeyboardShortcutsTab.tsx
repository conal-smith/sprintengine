// Shortcuts settings tab. A searchable, grouped editor over the T1 command
// registry and the T2 persisted keybinding settings. The tab reads effective
// bindings (override ?? registry default) rather than hardcoded display
// strings, records new chords through the T1 parser, and surfaces same-scope
// conflicts inline.
//
// The view-model helpers below are pure and exported so the focused test can
// cover search, conflict text, disable/reset, and recorder key parsing without
// a DOM. The component wires them to the workspace store and the recorder.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  LEGACY_COMMAND_ID_ALIASES,
  collapseDuplicateKeybindings,
  findKeybindingConflicts,
  keyFromEvent,
  normalizeKeybinding,
  renderKeybinding,
  keybindingSearchText,
  type CommandCategory,
  type CommandContribution,
  type CommandScope,
  type KeybindingConflict,
  type KeybindingConflictCandidate,
  type KeybindingPlatform,
} from '../../commands'
import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import type { KeybindingSettings } from '../../types/workspace'
import { SettingCard, SettingsPageHeader, SettingsSectionTitle } from './SettingsAtoms'
import { GhostButton, IconButton, InboxSearchInput, KbdChord, StatusDot, Tooltip } from '../ui'
import { ResetIcon } from '../AppIcons'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { defaultKeybindingsHere } from '../../commands/browserKeymap'

// --- View model (pure, exported for tests) ---------------------------------

export type ShortcutRow = {
  id: string
  title: string
  /** A built-in CommandCategory or a module command's own grouping label. */
  category: string
  scopes: readonly CommandScope[]
  /** Canonical registry defaults. */
  defaults: string[]
  /** Canonical user override, or null when none is persisted. */
  overrides: string[] | null
  disabled: boolean
  /** What actually fires: [] when disabled, else override ?? defaults. */
  effective: string[]
  /** Has a persisted override or disable flag. */
  customized: boolean
}

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  settings: 'Settings',
  command_palette: 'Command palette',
  workspace: 'Workspace',
  panel: 'Panels',
  git: 'Git',
  terminal: 'Terminal',
  diagnostics: 'Diagnostics',
}

// Module command categories are already display labels, so they pass through.
export function categoryLabel(category: string): string {
  return (CATEGORY_LABELS as Partial<Record<string, string>>)[category] ?? category
}

export function buildShortcutRows(
  commands: readonly CommandContribution[],
  keybindings: KeybindingSettings,
): ShortcutRow[] {
  return commands.map((def) => {
    const defaults = collapseDuplicateKeybindings(defaultKeybindingsHere(def.defaultKeybindings ?? []))
    // A migrated command's persisted override/disable may still live under
    // its legacy id — read both so this tab shows what dispatch actually does.
    const legacyId = LEGACY_COMMAND_ID_ALIASES[def.id]
    const rawOverride = keybindings.overrides[def.id] ?? (legacyId ? keybindings.overrides[legacyId] : undefined)
    const collapsedOverride = Array.isArray(rawOverride) ? collapseDuplicateKeybindings(rawOverride) : []
    const overrides = collapsedOverride.length > 0 ? collapsedOverride : null
    const disabled =
      keybindings.disabled[def.id] === true || (legacyId ? keybindings.disabled[legacyId] === true : false)
    const effective = disabled ? [] : (overrides ?? defaults)
    return {
      id: def.id,
      title: def.title,
      category: def.category,
      scopes: def.scopes,
      defaults,
      overrides,
      disabled,
      effective,
      customized: Boolean(overrides) || disabled,
    }
  })
}

// Command ids the shell has retired for good. The keybindings normalizer keeps
// ids it does not recognize on purpose — a disabled module's customizations have
// to survive re-enable — so nothing downstream can tell "gone for now" from
// "gone for good". A retired id therefore gets no row here and no dispatch
// (the dispatcher matches the live registry), leaving the user holding a stored
// binding they can neither see nor clear. This tab drops it on open. Every
// entry added here is a user-visible retirement and belongs in the release notes
// (`docs/release-checklist.md`).
export const RETIRED_COMMAND_IDS: readonly string[] = [
  // The Sprint Engines panel went with the in-tree sprint engine (2026-09-16).
  'panel.sprint-engines.toggle',
  // The sprint-engine module's board and New sprint commands (
  // registered them as `sprint-engine.<id>`), and the shell-registry
  // `sprintengine.*` spellings their stored bindings were keyed by before that
  // move.
  ...[
    'verify.progress',
    'add.role',
    'read.plan',
    'focus.agent',
    'refresh.board',
    'goto.inbox',
    'goto.roster',
    'goto.tasks',
    'goto.graph',
    'goto.kanban',
    'open.settings',
  ].flatMap((id) => [`sprint-engine.${id}`, `sprintengine.${id}`]),
  'sprint-engine.new',
  // The title-bar Attention Queue was removed: the sidebar rows and the Home
  // glyph's notifications already carry "which agents are waiting on you", so
  // the popover and its toggle command went with it.
  'panel.attention-queue.toggle',
  // Voice dictation was removed (2026-10-09): its module command, and the
  // shell-registry id its stored bindings were keyed by before it moved there.
  'voice-dictation.toggle',
  'voice.toggle',
]

/** Retired ids that still carry a persisted override or disable flag. */
export function retiredKeybindingIds(
  keybindings: KeybindingSettings,
  retired: readonly string[] = RETIRED_COMMAND_IDS,
): string[] {
  return retired.filter((id) => Boolean(keybindings.overrides[id]) || keybindings.disabled[id] === true)
}

function toCandidate(row: ShortcutRow): KeybindingConflictCandidate {
  return { commandId: row.id, commandTitle: row.title, keybindings: row.effective, scopes: row.scopes }
}

/** Conflicts keyed by command id. Disabled rows contribute no bindings, so
 *  disabling a command clears its conflicts. */
export function computeConflicts(rows: readonly ShortcutRow[]): Map<string, KeybindingConflict[]> {
  const candidates = rows.map(toCandidate)
  const byId = new Map<string, KeybindingConflict[]>()
  for (const candidate of candidates) {
    const conflicts = findKeybindingConflicts(candidate, candidates)
    if (conflicts.length > 0) byId.set(candidate.commandId, conflicts)
  }
  return byId
}

/** Short, color-independent conflict sentence that names the other command. */
export function conflictMessage(conflicts: readonly KeybindingConflict[]): string | null {
  if (conflicts.length === 0) return null
  const blocking = conflicts.find((conflict) => conflict.severity === 'blocking')
  const primary = blocking ?? conflicts[0]
  const extra = conflicts.length - 1
  const suffix = extra > 0 ? ` and ${extra} more` : ''
  const lead = primary.severity === 'blocking' ? 'Conflicts with' : 'Also set in'
  return `${lead} ${primary.conflictingCommandTitle}${suffix}`
}

export function conflictTone(conflicts: readonly KeybindingConflict[]): 'error' | 'warn' | null {
  if (conflicts.length === 0) return null
  return conflicts.some((conflict) => conflict.severity === 'blocking') ? 'error' : 'warn'
}

export function rowMatchesQuery(row: ShortcutRow, query: string, platform: KeybindingPlatform): boolean {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return true
  const rendered = [...row.effective, ...row.defaults].map((chord) => keybindingSearchText(chord, platform))
  const haystack = [row.title, categoryLabel(row.category), ...row.effective, ...row.defaults, ...rendered]
    .join(' ')
    .toLowerCase()
  return haystack.includes(trimmed)
}

export type ShortcutGroup = { category: string; label: string; rows: ShortcutRow[] }

/** Group rows by category, preserving the order categories first appear in. */
export function groupRows(rows: readonly ShortcutRow[]): ShortcutGroup[] {
  const groups: ShortcutGroup[] = []
  const index = new Map<string, ShortcutGroup>()
  for (const row of rows) {
    let group = index.get(row.category)
    if (!group) {
      group = { category: row.category, label: categoryLabel(row.category), rows: [] }
      index.set(row.category, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

const RECORDER_IGNORED_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'Dead', 'Unidentified'])

export type RecorderKeyEvent = {
  key: string
  /** Physical key code (e.g. `Slash`). Used for the key identity so it matches
   *  the dispatcher, which normalizes off `code` rather than the shifted key. */
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Convert a recorder keydown into a canonical chord, or null when the press is
 * a lone modifier / unparseable. The key identity comes from the dispatcher's
 * `keyFromEvent` (physical `code`), so e.g. Shift+/ records as `shift+/` and
 * resolves at dispatch instead of saving the unmatched shifted char `?`. The
 * platform's primary accelerator (Cmd on macOS, Ctrl elsewhere) maps to the
 * abstract `Primary` modifier so recorded chords match the registry convention
 * and conflict detection works cross-OS.
 */
export function eventToChordString(event: RecorderKeyEvent, platform: KeybindingPlatform): string | null {
  if (RECORDER_IGNORED_KEYS.has(event.key)) return null
  const modifiers: string[] = []
  if (platform === 'darwin') {
    if (event.metaKey) modifiers.push('Primary')
    if (event.ctrlKey) modifiers.push('Ctrl')
  } else {
    if (event.ctrlKey) modifiers.push('Primary')
    if (event.metaKey) modifiers.push('Meta')
  }
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  const keyToken = keyFromEvent(event)
  if (!keyToken) return null
  return normalizeKeybinding([...modifiers, keyToken].join('+'))
}

function resolvePlatform(): KeybindingPlatform {
  const platform = typeof window !== 'undefined' ? window.api?.platform : undefined
  if (platform === 'darwin') return 'darwin'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

// --- Component -------------------------------------------------------------

export function KeyboardShortcutsTab() {
  const overrides = useWorkspaceStore((s) => s.appSettings.keybindings.overrides)
  const disabled = useWorkspaceStore((s) => s.appSettings.keybindings.disabled)
  const setCommandKeybindings = useWorkspaceStore((s) => s.setCommandKeybindings)
  const setCommandKeybindingDisabled = useWorkspaceStore((s) => s.setCommandKeybindingDisabled)
  const resetCommandKeybindings = useWorkspaceStore((s) => s.resetCommandKeybindings)
  const resetAllKeybindings = useWorkspaceStore((s) => s.resetAllKeybindings)
  const dialog = useConfirmDialog()

  const platform = useMemo(resolvePlatform, [])
  const [query, setQuery] = useState('')
  const [recordingId, setRecordingId] = useState<string | null>(null)

  const keybindings = useMemo<KeybindingSettings>(() => ({ overrides, disabled }), [overrides, disabled])
  // Shell commands plus the commands of currently enabled modules. Disabling a
  // module drops its rows here reactively; its persisted overrides stay in
  // settings, so re-enabling restores the rows with the customization intact.
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  const [moduleRegistryGeneration, setModuleRegistryGeneration] = useState(0)
  useEffect(() => onThirdPartyRendererModulesLoaded(() => setModuleRegistryGeneration((value) => value + 1)), [])
  const commands = useMemo(
    () => getRendererHost().getCommandContributions((moduleId) => selectModuleEnabled(moduleEnablement, moduleId)),
    [moduleEnablement, moduleRegistryGeneration],
  )
  const rows = useMemo(() => buildShortcutRows(commands, keybindings), [commands, keybindings])
  // Retired commands never come back, so their stored deltas are dead weight no
  // row can reach. Clearing them here is the honest end of the retirement: the
  // reset is per id and idempotent, so the second pass finds nothing.
  const retiredIds = useMemo(() => retiredKeybindingIds(keybindings), [keybindings])
  useEffect(() => {
    for (const commandId of retiredIds) resetCommandKeybindings(commandId)
  }, [retiredIds, resetCommandKeybindings])
  const conflicts = useMemo(() => computeConflicts(rows), [rows])
  const visibleRows = useMemo(
    () => rows.filter((row) => rowMatchesQuery(row, query, platform)),
    [rows, query, platform],
  )
  const groups = useMemo(() => groupRows(visibleRows), [visibleRows])
  const customizedCount = useMemo(() => rows.filter((row) => row.customized).length, [rows])

  const handleCapture = useCallback(
    (commandId: string, chord: string) => {
      setCommandKeybindings(commandId, [chord])
      setCommandKeybindingDisabled(commandId, false)
      setRecordingId(null)
    },
    [setCommandKeybindings, setCommandKeybindingDisabled],
  )

  const handleResetAll = useCallback(async () => {
    const confirmed = await dialog.confirm({
      title: 'Reset all shortcuts?',
      body: 'Every custom shortcut and disabled command returns to its default. This cannot be undone.',
      confirmLabel: 'Reset all',
      tone: 'danger',
    })
    if (confirmed) resetAllKeybindings()
  }, [dialog, resetAllKeybindings])

  return (
    <div role="tabpanel" id="settings-panel-shortcuts" aria-labelledby="settings-tab-shortcuts" className="space-y-4">
      {/* The page's chrome, on the header band: the count,
          the search field, and the reset as a glyph that names how many it
          would undo. */}
      <SettingsPageHeader
        title="Shortcuts"
        meta={`${rows.length} bindings`}
        actions={
          <>
            <div className="flex w-52 max-w-full">
              <InboxSearchInput
                value={query}
                onChange={setQuery}
                ariaLabel="Search shortcuts by command, category, or key"
                placeholder="Search"
              />
            </div>
            <Tooltip content={customizedCount > 0 ? `Reset all (${customizedCount} changed)` : 'Nothing to reset'}>
              <IconButton
                onClick={handleResetAll}
                disabled={customizedCount === 0}
                aria-label="Reset all keyboard shortcuts to defaults"
              >
                <ResetIcon className="icon-sm" />
              </IconButton>
            </Tooltip>
          </>
        }
      />

      {groups.length === 0 ? (
        <p className="px-1 py-6 text-center text-body text-[color:var(--text-muted)]">
          No commands match “{query.trim()}”.
        </p>
      ) : (
        <div className="flex flex-col">
          {groups.map((group, index) => (
            <section
              key={group.category}
              // No rule between groups: each group's card draws its own edge,
              // so a border here was a second boundary beside the first.
              className={index > 0 ? 'mt-5' : ''}
            >
              <SettingsSectionTitle count={group.rows.length} className="mb-1.5">
                {group.label}
              </SettingsSectionTitle>
              <SettingCard as="ul">
                {group.rows.map((row) => (
                  <ShortcutRowView
                    key={row.id}
                    row={row}
                    platform={platform}
                    conflicts={conflicts.get(row.id) ?? []}
                    recording={recordingId === row.id}
                    onStartRecording={() => setRecordingId(row.id)}
                    onCancelRecording={() => setRecordingId((current) => (current === row.id ? null : current))}
                    onCapture={(chord) => handleCapture(row.id, chord)}
                    onRemove={() => {
                      setCommandKeybindingDisabled(row.id, true)
                      setRecordingId((current) => (current === row.id ? null : current))
                    }}
                    onReset={() => {
                      resetCommandKeybindings(row.id)
                      setRecordingId((current) => (current === row.id ? null : current))
                    }}
                  />
                ))}
              </SettingCard>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function ShortcutRowView({
  row,
  platform,
  conflicts,
  recording,
  onStartRecording,
  onCancelRecording,
  onCapture,
  onRemove,
  onReset,
}: {
  row: ShortcutRow
  platform: KeybindingPlatform
  conflicts: readonly KeybindingConflict[]
  recording: boolean
  onStartRecording: () => void
  onCancelRecording: () => void
  onCapture: (chord: string) => void
  onRemove: () => void
  onReset: () => void
}) {
  const tone = conflictTone(conflicts)
  const message = conflictMessage(conflicts)
  const hasBinding = row.effective.length > 0
  const defaultRendered = row.defaults.map((chord) => renderKeybinding(chord, platform)).join(' or ')

  return (
    <li className="group flex items-center gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-body text-[color:var(--text-strong)]">{row.title}</span>
        {tone && message ? (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <StatusDot tone={tone} label={message} />
            <span
              className={`whitespace-nowrap text-meta ${tone === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--tone-warn)]'}`}
            >
              {message}
            </span>
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <KeybindingCell
          row={row}
          platform={platform}
          recording={recording}
          onStartRecording={onStartRecording}
          onCancelRecording={onCancelRecording}
          onCapture={onCapture}
        />
        <span className="flex w-[52px] items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {row.customized ? (
            <Tooltip content={defaultRendered ? `Reset to ${defaultRendered}` : 'Reset to default'}>
              <IconButton onClick={onReset} aria-label={`Reset the ${row.title} shortcut to default`}>
                <ResetIcon className="icon-sm" />
              </IconButton>
            </Tooltip>
          ) : null}
          {hasBinding ? (
            <Tooltip content="Remove shortcut">
              <IconButton onClick={onRemove} aria-label={`Remove the ${row.title} shortcut`}>
                <RemoveIcon />
              </IconButton>
            </Tooltip>
          ) : null}
        </span>
      </div>
    </li>
  )
}

function ChordList({ chords, platform }: { chords: readonly string[]; platform: KeybindingPlatform }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      {chords.map((chord, index) => (
        <React.Fragment key={chord}>
          {index > 0 ? <span className="text-meta text-[color:var(--text-subtle)]">or</span> : null}
          <KbdChord chord={chord} platform={platform} />
        </React.Fragment>
      ))}
    </span>
  )
}

// The keybinding cell is the edit affordance: click to record, Escape to cancel.
// At rest it shows the effective chord(s), or a muted "Add shortcut" prompt when
// the command has none (default removed or never bound).
function KeybindingCell({
  row,
  platform,
  recording,
  onStartRecording,
  onCancelRecording,
  onCapture,
}: {
  row: ShortcutRow
  platform: KeybindingPlatform
  recording: boolean
  onStartRecording: () => void
  onCancelRecording: () => void
  onCapture: (chord: string) => void
}) {
  const liveId = useRef(`shortcut-recorder-${row.id}`).current
  const hasBinding = row.effective.length > 0

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!recording) return
      // Tab must move focus, not be trapped — let it bubble and end recording.
      if (event.key === 'Tab') {
        onCancelRecording()
        return
      }
      // Swallow everything else so Settings does not close and app shortcuts do
      // not fire while capturing (the overlay closes on a bubbling Escape).
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        onCancelRecording()
        return
      }
      const chord = eventToChordString(event, platform)
      if (chord) onCapture(chord)
    },
    [recording, platform, onCancelRecording, onCapture],
  )

  return (
    <>
      {/* `armed`, not `pressed`: the recorder is LISTENING, which is the one
          borderless state that takes the accent — as a tint, for the moment it
          lasts. `end`, because the chord is right-aligned under its column. */}
      <GhostButton
        size="sm"
        align="end"
        armed={recording}
        aria-pressed={recording}
        aria-describedby={recording ? liveId : undefined}
        aria-label={
          recording
            ? `Recording a shortcut for ${row.title}. Press a key combination, or Escape to cancel.`
            : hasBinding
              ? `Change the ${row.title} shortcut`
              : `Add a shortcut for ${row.title}`
        }
        onClick={() => (recording ? onCancelRecording() : onStartRecording())}
        onKeyDown={handleKeyDown}
        onBlur={() => recording && onCancelRecording()}
        className="min-w-[72px]"
      >
        {recording ? (
          <span className="text-body font-medium text-[color:var(--accent-primary)]">Press keys…</span>
        ) : hasBinding ? (
          <ChordList chords={row.effective} platform={platform} />
        ) : (
          <span className="text-body text-[color:var(--text-subtle)] group-hover:text-[color:var(--text-muted)]">
            Add shortcut
          </span>
        )}
      </GhostButton>
      <span id={liveId} role="status" aria-live="polite" className="sr-only">
        {recording ? `Recording a shortcut for ${row.title}. Press Escape to cancel.` : ''}
      </span>
    </>
  )
}

function RemoveIcon() {
  return (
    <svg
      className="icon-sm"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  )
}
