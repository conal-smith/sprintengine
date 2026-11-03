import type { InstalledPluginRecord } from '../../../../../../shared/ipc/skills'
import type { AgentMcpServer, ScannedMcpServer, ScannedPlugin } from '../../../../../../shared/skills'
import { normalizeMcpId } from '../../../../store/slices/settingsSlice'

// The decisions behind the plugin card an agent's `plugin.offer` draws in a
// chat, kept apart from the drawing so each can be tested on its own.

export type PluginOfferIds = { sourceId: string; pluginId: string }

/** The ids the agent passed; null when the call carried none to draw from. */
export function pluginOfferIds(input: unknown): PluginOfferIds | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const { sourceId, pluginId } = input as Record<string, unknown>
  if (typeof sourceId !== 'string' || !sourceId.trim()) return null
  if (typeof pluginId !== 'string' || !pluginId.trim()) return null
  return { sourceId, pluginId }
}

/**
 * What the card's one button does. `install` opens the dialog, `sign-in` asks
 * this chat to sign in to the server that needs it, and `manage` opens the
 * plugin in the Extensions door.
 */
export type PluginOfferAction = 'install' | 'sign-in' | 'manage'

export function pluginOfferAction(input: {
  installed: boolean
  /** A server the plugin installed that a chat here reported as needing sign-in. */
  signInServerId: string | null
  /** This chat can sign in to one of its servers. */
  canSignIn: boolean
}): PluginOfferAction {
  if (!input.installed) return 'install'
  if (input.signInServerId && input.canSignIn) return 'sign-in'
  return 'manage'
}

/** The install receipt for this plugin in this workspace, if it is in. */
export function installedRecord(
  records: readonly InstalledPluginRecord[],
  ids: PluginOfferIds,
): InstalledPluginRecord | null {
  return records.find((record) => record.sourceId === ids.sourceId && record.pluginId === ids.pluginId) ?? null
}

/** The first server this install added that a chat here says needs signing in to. */
export function serverNeedingSignIn(
  record: InstalledPluginRecord | null,
  servers: readonly AgentMcpServer[],
): string | null {
  const ours = serverIdsOf(record)
  return servers.find((server) => ours.has(normalizeMcpId(server.id)) && server.status === 'needs-auth')?.id ?? null
}

/**
 * The servers an install added, as the CLIs name them: the receipt keeps a
 * plugin's own `.mcp.json` keys (`Linear`, `foo.bar`), and Studio's settings,
 * and so every CLI's config, keep them normalised (`linear`, `foo-bar`).
 */
function serverIdsOf(record: InstalledPluginRecord | null): Set<string> {
  return new Set((record?.mcpServerIds ?? []).map(normalizeMcpId))
}

/** True when a server this install added is connected in a chat here. */
export function serverConnected(record: InstalledPluginRecord | null, servers: readonly AgentMcpServer[]): boolean {
  const ours = serverIdsOf(record)
  return servers.some((server) => ours.has(normalizeMcpId(server.id)) && server.status === 'connected')
}

/**
 * Skills preselected only when there are few of them. A marketplace plugin can
 * ship fifty, and an Install press that copied all of them into every agent's
 * skills folder is the outcome the dialog's checkboxes exist to prevent: past
 * this many, the person picks the ones they want.
 */
export const PRESELECT_SKILLS_UP_TO = 8

/** What the dialog starts with ticked: every server, and the skills when there are few. */
export function initialSelection(plugin: ScannedPlugin): { skillIds: Set<string>; serverIds: Set<string> } {
  const { skills, mcpServers } = plugin.components
  return {
    skillIds: new Set(skills.length <= PRESELECT_SKILLS_UP_TO ? skills.map((skill) => skill.id) : []),
    serverIds: new Set(mcpServers.map((server) => server.id)),
  }
}

/**
 * How a server is shown in the dialog. One that runs on this machine shows
 * its whole command, never cut short: it runs with the person's own
 * permissions, and the command is what they are trusting. One reached over
 * the network shows where it goes.
 */
export function describeServer(server: ScannedMcpServer): { code: string; description: string } {
  if (server.transport === 'stdio') {
    return {
      code: [server.command, ...server.args].filter(Boolean).join(' '),
      description: server.description || 'Runs on this computer',
    }
  }
  return { code: server.url, description: server.description || 'Connects over the internet' }
}

/** True once the plugin has been read whole, so its skills and servers can be listed. */
export function pluginReadWhole(plugin: ScannedPlugin): boolean {
  if (!plugin.componentsKnown) return false
  if (plugin.readState?.status === 'listed') return false
  // A linked plugin pinned to nothing means "the ref's head at install", so it
  // is read again before its contents are shown as what will be installed.
  return !(plugin.origin.kind === 'linked' && plugin.origin.sha === '')
}
