import type { SkillScanOutcome, SkillScanInput, SkillSourcesResult } from '../../shared/ipc/skills'
import { toolError, type McpToolRegistration, type McpToolResult } from '../../shared/modules/mcp-tools'
import { scanPlugins, type ScannedPlugin, type SkillSource } from '../../shared/skills'
import { STUDIO_PLUGIN_ID } from '../../shared/studio-plugin'

// How an agent puts a plugin in front of the person: `plugin.search` finds one
// in the sources the Extensions door lists, and `plugin.offer` draws it in the
// chat as a card with an Install button (owner ruling 2026-11-02). Neither
// installs anything. The agent names a plugin by the ids search answered, never
// by a command or a URL, and the card is drawn from the catalogue rather than
// from anything the agent wrote, so what the person is asked to trust is what
// the source says, not what the agent claims. The click is the person's; the
// install dialog it opens is where the source, the servers and the skills are
// shown and chosen.

export const PLUGIN_SEARCH_TOOL = 'plugin.search'
export const PLUGIN_OFFER_TOOL = 'plugin.offer'

/** Enough to choose from without filling the agent's context with a catalogue. */
const MAX_RESULTS = 25
const MAX_DESCRIPTION_CHARS = 240
/**
 * How long one source may take. A source nothing has read yet is read from
 * its repository now, and one slow source must not hold up the answer from
 * the others, or the whole search outlast the gateway's own time limit.
 */
const SOURCE_READ_MS = 15_000

export type PluginToolsDeps = {
  listSources: () => Promise<SkillSourcesResult>
  getScan: (input: SkillScanInput) => Promise<SkillScanOutcome>
  /** Tests shorten it. */
  sourceReadMs?: number
}

/**
 * The plugins of a scan an agent may offer: all of them but Studio's own,
 * which the app installs into every workspace itself and no catalogue install
 * can take (install-plugin.ts refuses it).
 */
function offerable(scan: Extract<SkillScanOutcome, { ok: true }>): ScannedPlugin[] {
  return scanPlugins(scan.scan).filter((plugin) => plugin.id !== STUDIO_PLUGIN_ID)
}

async function scanWithin(deps: PluginToolsDeps, sourceId: string): Promise<SkillScanOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.sourceReadMs ?? SOURCE_READ_MS)
  })
  try {
    return await Promise.race([deps.getScan({ sourceId }).catch(() => null), late])
  } finally {
    clearTimeout(timer)
  }
}

function json(structured: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…` : flat
}

function matches(plugin: ScannedPlugin, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const haystack = [plugin.id, plugin.name, plugin.description, plugin.category, ...plugin.tags, ...plugin.keywords]
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

function summary(source: SkillSource, plugin: ScannedPlugin): Record<string, unknown> {
  return {
    sourceId: source.id,
    source: source.name,
    pluginId: plugin.id,
    name: plugin.name,
    description: clip(plugin.description),
    // Counted only once the plugin has been read whole; a linked plugin
    // listed but not yet read would say "0 skills" and be wrong.
    ...(plugin.componentsKnown
      ? { skills: plugin.components.skills.length, mcpServers: plugin.components.mcpServers.length }
      : {}),
  }
}

export function createPluginTools(deps: PluginToolsDeps): McpToolRegistration[] {
  const search: McpToolRegistration = {
    name: PLUGIN_SEARCH_TOOL,
    description:
      'Search the plugins the person can install from the sources in Studio’s Extensions door (plugin ' +
      'marketplaces such as claude-plugins-official, and any they added). A plugin bundles skills and MCP ' +
      'servers that connect you to a service. Answers each match’s sourceId and pluginId, which plugin.offer ' +
      'takes. Installs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Words to match against plugin names, descriptions and tags, e.g. "sentry" or "postgres". Omit to list them all.',
        },
      },
      additionalProperties: false,
    },
    mutates: false,
    handler: async (args) => {
      const { query } = args
      if (query !== undefined && typeof query !== 'string') {
        return toolError('invalid_arguments', '"query" is text when given.')
      }
      const listed = await deps.listSources()
      if (!listed.ok) return toolError('sources_unavailable', listed.message)
      const words = (query ?? '').toLowerCase().split(/\s+/u).filter(Boolean)
      // A source that cannot be read now is named rather than dropped, so an
      // empty answer is not mistaken for "there is no such plugin".
      const unreadable: string[] = []
      const scans = await Promise.all(
        listed.sources.map(async (source) => {
          const scan = await scanWithin(deps, source.id)
          if (!scan?.ok) {
            unreadable.push(source.name)
            return []
          }
          return offerable(scan)
            .filter((plugin) => matches(plugin, words))
            .map((plugin) => summary(scan.source, plugin))
        }),
      )
      const found = scans.flat()
      return json({
        ok: true,
        total: found.length,
        plugins: found.slice(0, MAX_RESULTS),
        ...(found.length > MAX_RESULTS ? { note: `Showing ${MAX_RESULTS}; narrow the query to see the rest.` } : {}),
        ...(unreadable.length > 0 ? { unreadableSources: unreadable } : {}),
      })
    },
  }

  const offer: McpToolRegistration = {
    name: PLUGIN_OFFER_TOOL,
    description:
      'Show the person a plugin in this chat, as a card with an Install button. Use it when they ask to ' +
      'install or connect something, or when the task needs a service you cannot reach and a plugin from ' +
      'plugin.search provides it; say in your reply why you are offering it. Never offer one they did not ' +
      'need, and offer one plugin per call. Nothing is installed until they press Install and confirm which ' +
      'skills and servers to take, so do not wait for it: carry on, or end your turn and let them tell you ' +
      'when it is in. An MCP server it adds may not be among your tools until a new chat.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'The plugin’s sourceId, as plugin.search answered it.' },
        pluginId: { type: 'string', description: 'The plugin’s pluginId, as plugin.search answered it.' },
      },
      required: ['sourceId', 'pluginId'],
      additionalProperties: false,
    },
    mutates: false,
    handler: async (args) => {
      const { sourceId, pluginId } = args
      if (typeof sourceId !== 'string' || !sourceId.trim() || typeof pluginId !== 'string' || !pluginId.trim()) {
        return toolError('invalid_arguments', '"sourceId" and "pluginId" are the ids plugin.search answered.')
      }
      const scan = await deps.getScan({ sourceId })
      if (!scan.ok) return toolError('unknown_source', scan.message)
      const plugin = offerable(scan).find((candidate) => candidate.id === pluginId)
      if (!plugin) {
        return toolError(
          'unknown_plugin',
          `${scan.source.name} has no plugin "${pluginId}". Find it with plugin.search.`,
        )
      }
      return json({
        ok: true,
        ...summary(scan.source, plugin),
        shown: 'The card is in the chat. The person installs it from there, or not.',
      })
    },
  }

  return [search, offer]
}
