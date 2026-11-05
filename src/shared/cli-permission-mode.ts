import {
  DEFAULT_CLI_PERMISSION_PRESET,
  parseCliPermissionPreset,
  type CliPermissionPreset,
} from './cli-permission-preset'

/**
 * A permission mode as its CLI names it (owner request 2026-10-01): Claude
 * Code's Accept edits and Don't ask, Codex's Read only and Default, Cursor's
 * Run Everything. The menus list each CLI's own modes under their own names
 * rather than the same four everywhere.
 *
 * Every mode sits at one of the four generic presets, its `level`, and the app
 * reasons only in levels: the gateway's launch cap, the stricter and looser
 * notices, what a chat's runtime answers without a card
 * (`permissionModeAllows`), and what a caller that names a generic preset (an
 * MCP tool, an automation, an older paired Studio, a third-party manifest)
 * gets. A level reads as the CLI's own mode for it: the mode whose id is that
 * preset's name. A CLI's other modes have ids of their own and travel beside
 * their level as an optional `permissionMode`, which a peer that does not know
 * it ignores, falling back to the level's mode.
 */
export type CliPermissionModeSpec = {
  /** Stable. A generic preset's name for the mode that stands for that preset. */
  id: string
  /** The CLI's own name for it. */
  label: string
  /** One line for a menu row. */
  summary?: string
  /** The full explanation, for a tooltip. */
  description?: string
  level: CliPermissionPreset
  /** The CLI can change nothing in this mode. */
  readOnly?: true
}

// What a runtime may name one of its own modes: short, and nothing a path,
// a flag or a markup fragment could be read as.
const MODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/

/**
 * A runtime's own mode id from a stored or received value, or null. A generic
 * preset, or a retired spelling of one, is not a mode id of its own: it is the
 * level, which the preset field beside it already says, so it reads as none.
 */
export function parseCliPermissionModeId(input: unknown): string | null {
  if (typeof input !== 'string' || !MODE_ID.test(input)) return null
  return parseCliPermissionPreset(input) === null ? input : null
}

/**
 * The preset a launch takes when the person never chose one: Auto, the
 * runtime's own mode that neither asks about everything nor skips every check
 * (owner request 2026-10-01). A CLI with no Auto (Kimi Code's only flag runs
 * fully autonomous) passes no flag, so it runs on its own configuration; it is
 * never given something looser in Auto's place.
 */
export function defaultPermissionPresetFor(
  declared: readonly CliPermissionPreset[] | null | undefined,
): CliPermissionPreset {
  return declared && !declared.includes(DEFAULT_CLI_PERMISSION_PRESET) ? 'none' : DEFAULT_CLI_PERMISSION_PRESET
}

/**
 * What a terminal launch renders its permission flags from: a preset, or one
 * of the CLI's own mode ids (`permissionRenderKey`). The manifest's entry
 * under that key is what the CLI is told.
 */
export type CliPermissionSetting = CliPermissionPreset | (string & {})
