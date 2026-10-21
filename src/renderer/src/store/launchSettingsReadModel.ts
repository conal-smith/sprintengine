/**
 * The seam between the store's `appSettings` and main's agent-launch settings.
 *
 * Eleven `appSettings` fields are a read model of main's record rather than
 * settings this window owns: they are filled from main, never persisted to
 * localStorage, and ignored when a persisted envelope is read back (except
 * once, as the migration offer — see `launchSettingsClient`). Everything that
 * needs to know which fields those are, or to convert between the two shapes,
 * goes through here so the list cannot drift.
 */
import {
  effectiveAgentLaunchSettings,
  normalizeCliPermissionModes,
  normalizeCliPermissionPresets,
  type AgentLaunchSettings,
} from '../../../shared/launch-settings'
import { normalizeProjectUsageMap } from '../../../shared/project-frecency'
import { AGENT_BRANCH_PREFIX } from '../../../shared/worktree-branch'
import type { AppSettings, Workspace } from '../types/workspace'
import { normalizeAppSettings } from './slices/settingsSlice'

export const LAUNCH_SETTINGS_KEYS = [
  'cliRuntimes',
  'hosts',
  'machineMarks',
  'mcp',
  'projectKnowledgeRoots',
  'lastSelectedCli',
  'lastAgentSpawnPermissionPreset',
  'cliPermissionPresets',
  'cliPermissionModes',
  'projectUsage',
  'worktreeBranchPrefix',
] as const

type LaunchSettingsKey = (typeof LAUNCH_SETTINGS_KEYS)[number]

type LaunchSettingsFields = Pick<AppSettings, LaunchSettingsKey>

export function withoutLaunchSettings<T extends object>(appSettings: T): Omit<T, LaunchSettingsKey> {
  const rest = { ...appSettings } as Record<string, unknown>
  for (const key of LAUNCH_SETTINGS_KEYS) delete rest[key]
  return rest as Omit<T, LaunchSettingsKey>
}

export function pickLaunchSettings(appSettings: AppSettings): LaunchSettingsFields {
  return {
    cliRuntimes: appSettings.cliRuntimes,
    hosts: appSettings.hosts,
    machineMarks: appSettings.machineMarks,
    mcp: appSettings.mcp,
    projectKnowledgeRoots: appSettings.projectKnowledgeRoots,
    lastSelectedCli: appSettings.lastSelectedCli,
    lastAgentSpawnPermissionPreset: appSettings.lastAgentSpawnPermissionPreset,
    cliPermissionPresets: appSettings.cliPermissionPresets,
    cliPermissionModes: appSettings.cliPermissionModes,
    projectUsage: appSettings.projectUsage,
    worktreeBranchPrefix: appSettings.worktreeBranchPrefix,
  }
}

/** The raw launch fields a persisted `appSettings` blob still carries, or null when it carries none. */
export function persistedLaunchSettingsFields(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const fields: Record<string, unknown> = {}
  for (const key of LAUNCH_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) fields[key] = (raw as Record<string, unknown>)[key]
  }
  return Object.keys(fields).length > 0 ? fields : null
}

/** The shape main stores, from this window's `appSettings`. */
export function launchSettingsFromAppSettings(appSettings: AppSettings): AgentLaunchSettings {
  return {
    cliRuntimes: appSettings.cliRuntimes ?? {},
    hosts: appSettings.hosts ?? {},
    machineMarks: appSettings.machineMarks ?? {},
    mcp: appSettings.mcp ?? { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: appSettings.projectKnowledgeRoots ?? {},
    lastSelectedCli: appSettings.lastSelectedCli ?? null,
    lastAgentSpawnPermissionPreset: appSettings.lastAgentSpawnPermissionPreset ?? null,
    cliPermissionPresets: normalizeCliPermissionPresets(appSettings.cliPermissionPresets),
    cliPermissionModes: normalizeCliPermissionModes(appSettings.cliPermissionModes),
    projectUsage: normalizeProjectUsageMap(appSettings.projectUsage),
    // The default is what every window held before it could be chosen, so it
    // is offered as never chosen.
    worktreeBranchPrefix:
      appSettings.worktreeBranchPrefix === AGENT_BRANCH_PREFIX ? null : appSettings.worktreeBranchPrefix,
  }
}

/**
 * `appSettings` with its launch fields replaced by main's settings, through the
 * same normalizers a hydration uses: the default runtimes are filled in, a
 * never-chosen CLI or preset reads as the app default (effectiveAgentLaunchSettings), MCP entries are
 * normalized, and knowledge roots fold in the ones the open workspaces carry.
 */
export function withLaunchSettings(
  appSettings: AppSettings,
  settings: AgentLaunchSettings,
  workspaces: Workspace[],
): AppSettings {
  // Never-chosen values read as the app defaults through the same function
  // main launches with, so a picker never shows what main would not run.
  const effective = effectiveAgentLaunchSettings(settings)
  const normalized = normalizeAppSettings(
    {
      cliRuntimes: effective.cliRuntimes,
      hosts: effective.hosts,
      machineMarks: effective.machineMarks,
      mcp: effective.mcp,
      projectKnowledgeRoots: effective.projectKnowledgeRoots,
      lastSelectedCli: effective.lastSelectedCli,
      lastAgentSpawnPermissionPreset: effective.lastAgentSpawnPermissionPreset,
      cliPermissionPresets: effective.cliPermissionPresets,
      cliPermissionModes: effective.cliPermissionModes,
      projectUsage: effective.projectUsage,
      worktreeBranchPrefix: effective.worktreeBranchPrefix,
    },
    workspaces,
  )
  return { ...appSettings, ...pickLaunchSettings(normalized) }
}

/** Whether two `appSettings` values hold the same launch fields. */
export function launchSettingsFieldsEqual(left: AppSettings, right: AppSettings): boolean {
  return JSON.stringify(pickLaunchSettings(left)) === JSON.stringify(pickLaunchSettings(right))
}
