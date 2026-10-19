// The models a chat can switch between, as this machine's own picker lists them,
// for a paired device that drives the chat over the tailnet.
//
// A chat agent runs on one CLI, and its picker offers that CLI's catalog: what
// the CLI reported about itself (the manifest's seed until it has), then the
// ids the person added in Settings. The renderer builds that list from the
// plugin catalog, the discovered catalogs and the CLI runtimes it holds; this
// builds the same list in main from the same three sources — the plugin
// registry, the discovery cache main keeps under userData, and the launch
// settings main owns — through the one merge both sides share
// (`mergeCliModelCatalog`). A remote picker therefore offers the rows a person
// sitting at this machine would see, and the gateway refuses any other id.
import {
  CONVERSATION_DEFAULT_MODEL_ID,
  CONVERSATION_MAX_MODEL_OPTIONS,
  type ConversationWireModels,
} from '../../packages/conversation-protocol/src'
import { mergeCliModelCatalog, type DiscoveredCliModelCatalog } from '../shared/cli-model-catalog'
import { cliForConversationProvider } from '../shared/conversation-harness'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'

/** A chat's CLI and its catalog. Whether the provider switches mid-conversation is the gateway's to add. */
export type ConversationModelCatalog = Omit<ConversationWireModels, 'liveModelSwitch'>

// The wire's bounds on one row. A row past them is dropped rather than cut: a
// shortened id is a different model, and a label is only worth showing whole.
const MAX_MODEL_ID_CHARS = 200
const MAX_MODEL_LABEL_CHARS = 200

export type ConversationModelCatalogDeps = {
  listClis: () => ReadonlyArray<Pick<PluginRegistryListEntry, 'id' | 'displayName' | 'modelSelection'>>
  /** The discovered catalogs, keyed by CLI id; an unreadable cache reads as none. */
  readDiscovered: () => Promise<Record<string, DiscoveredCliModelCatalog>>
  /** The ids the person added for a CLI in Settings. */
  userModels: (cli: string) => readonly string[] | undefined
  now?: () => number
}

/**
 * The catalog for a conversation provider: null for a provider that is not a
 * CLI, a CLI this app does not hold, or one whose manifest offers no model
 * choice. `CONVERSATION_DEFAULT_MODEL_ID` is never listed — the CLI's own
 * default is its own row, named after the CLI.
 */
export function createConversationModelCatalog(
  deps: ConversationModelCatalogDeps,
): (providerId: string) => Promise<ConversationModelCatalog | null> {
  const now = deps.now ?? Date.now
  return async (providerId) => {
    const cli = cliForConversationProvider(providerId)
    if (!cli) return null
    const entry = deps.listClis().find((candidate) => candidate.id === cli)
    if (!entry) return null
    const discovered = await deps.readDiscovered().catch((): Record<string, DiscoveredCliModelCatalog> => ({}))
    const merged = mergeCliModelCatalog(entry.modelSelection, [...(deps.userModels(cli) ?? [])], discovered[cli], now())
    if (!merged) return null
    const listed = merged.options.filter(
      (option) => option.id !== CONVERSATION_DEFAULT_MODEL_ID && option.id.length <= MAX_MODEL_ID_CHARS,
    )
    // A CLI can report more models than the wire carries (Cursor lists about
    // 240), and the ids the person added come last in the merge, so a plain
    // cut dropped every one of them. Theirs are kept first; the CLI's own fill
    // the rest in its order, and the list keeps the merge's order.
    const users = listed.filter((option) => option.origin === 'user').slice(0, CONVERSATION_MAX_MODEL_OPTIONS)
    const room = CONVERSATION_MAX_MODEL_OPTIONS - users.length
    const kept = new Set([...listed.filter((option) => option.origin !== 'user').slice(0, room), ...users])
    const options: ConversationModelCatalog['options'] = []
    for (const option of listed) {
      if (!kept.has(option)) continue
      const label = option.label?.trim()
      options.push({ id: option.id, ...(label && label.length <= MAX_MODEL_LABEL_CHARS ? { label } : {}) })
    }
    return { cli, cliLabel: entry.displayName, options }
  }
}
