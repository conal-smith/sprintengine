import { TAILNET_SCOPES, type TailnetScope } from '../../../../shared/tailnet'

// The permission vocabulary a person actually chooses from, DOM-free
// (remote-settings-rebuild).
//
// One list, in `TAILNET_SCOPES` order, with a title in the reader's language, the
// identifier in the system's, and one line of consequence. It lives apart from
// the component because THREE surfaces ask the same question — the Pair a device
// modal, the inbound pair-request card, and the machine row's Grant — and a
// second spelling of "what does Standard mean" is how a scope goes missing from
// one pairing path while the others still offer it.
//
// The rows are per-SCOPE and not per-family. The old four-row shape
// ("Workspaces — read & operate") bundled `operate` with `read`, so a person
// who wanted a machine to WATCH their work had to also let it act on it.
//
// Each row says exactly what its scope grants and nothing it does not.

export type ScopeRow = {
  scope: TailnetScope
  /** The name in the reader's language. */
  title: string
  /** The same fact in the system's vocabulary, shown beside the title. */
  code: TailnetScope
  /** ONE line: what holding it lets the other machine do. */
  description: string
}

/**
 * Every scope, in the vocabulary's own order, with its copy.
 *
 * Order is `TAILNET_SCOPES` and not a curated one: the same order the pairing
 * request, the audit line and the scope pills use, so a person comparing the
 * rows here with the pills on the code card is comparing two renderings of one
 * list rather than two lists.
 */
export const SCOPE_ROWS: readonly ScopeRow[] = [
  {
    scope: 'workspace:read',
    title: 'View workspaces',
    code: 'workspace:read',
    description: 'Workspaces, agents, branches and files.',
  },
  {
    scope: 'workspace:operate',
    title: 'Operate workspaces',
    code: 'workspace:operate',
    description: 'Launch agents and open workspaces.',
  },
  { scope: 'backlog:read', title: 'View backlog', code: 'backlog:read', description: 'Items, epics and triage.' },
  {
    scope: 'backlog:operate',
    title: 'Operate backlog',
    code: 'backlog:operate',
    description: 'Edit, assign and set status.',
  },
  {
    scope: 'conversation:read',
    title: 'View conversations',
    code: 'conversation:read',
    description: 'Read chat transcripts, tool details and diffs.',
  },
  {
    scope: 'conversation:operate',
    title: 'Operate conversations',
    code: 'conversation:operate',
    description: 'Send messages, stop turns and answer approvals and questions in chats.',
  },
]

export type ScopePreset = 'read-only' | 'standard'

/** Read only: every `:read`. */
export const READ_ONLY_SCOPES: readonly TailnetScope[] = TAILNET_SCOPES.filter((scope) => scope.endsWith(':read'))

/**
 * Standard: every scope, both conversation scopes included (owner ruling
 * 2026-09-10). This surface shows every row, and the person un-ticks what they
 * do not want; a default that silently left a scope out is what once left
 * paired machines unable to see each other's chats.
 */
export const STANDARD_SCOPES: readonly TailnetScope[] = TAILNET_SCOPES

const PRESET_SCOPES: Record<ScopePreset, readonly TailnetScope[]> = {
  'read-only': READ_ONLY_SCOPES,
  standard: STANDARD_SCOPES,
}

/** The set a preset stands for, as a fresh array the caller may own. */
export function scopesForPreset(preset: ScopePreset): TailnetScope[] {
  return [...PRESET_SCOPES[preset]]
}

/**
 * Which preset a set of scopes IS, or null when it is neither.
 *
 * Set equality, not order or identity: a chosen set arrives in whatever order
 * the rows were ticked, a stored one in vocabulary order, and a preset that
 * only re-lit for one of those spellings would look broken half the time.
 * Null is the honest answer for a hand-picked set — the segmented control then
 * shows neither segment as chosen, which is what "you have made your own
 * choice" looks like.
 */
export function presetFor(scopes: readonly TailnetScope[]): ScopePreset | null {
  const chosen = new Set(scopes)
  for (const preset of ['read-only', 'standard'] as const) {
    const want = PRESET_SCOPES[preset]
    if (want.length === chosen.size && want.every((scope) => chosen.has(scope))) return preset
  }
  return null
}

/**
 * Add or remove one scope, keeping the result in vocabulary order.
 *
 * Ordering here rather than at each caller is what makes `presetFor` and the
 * scope pills agree with the stored device: a set is a set, but the pills are
 * drawn in array order and a person who ticked the last row first should not see
 * their scopes listed backwards.
 */
export function toggleScope(scopes: readonly TailnetScope[], scope: TailnetScope, next: boolean): TailnetScope[] {
  const chosen = new Set(scopes)
  if (next) chosen.add(scope)
  else chosen.delete(scope)
  return TAILNET_SCOPES.filter((candidate) => chosen.has(candidate))
}

/**
 * The scopes NOT in a set, in vocabulary order — what the machine row's popover
 * lists under "Not granted".
 */
export function missingScopes(scopes: readonly TailnetScope[]): TailnetScope[] {
  const held = new Set(scopes)
  return TAILNET_SCOPES.filter((scope) => !held.has(scope))
}

/**
 * The consequence line for a grant missing a conversation scope, or null.
 *
 * Chats are what a paired machine is for, and a pairing without the scopes that
 * show them reads as the feature being broken rather than as a scope nobody
 * granted. The line names only that consequence; the lists above it say the
 * rest.
 */
export function conversationGapNote(scopes: readonly TailnetScope[]): string | null {
  const held = new Set(scopes)
  if (held.has('conversation:operate')) return null
  if (held.has('conversation:read')) return 'It can read chats here but not send to them.'
  return "It can't see chats here."
}

/**
 * What an MCP client signing in is offered, ticked: Read only, within what it
 * asked for. A client asks for every scope it might ever use (it reads them
 * off the server's own list), so starting from its ask would make "everything"
 * the one-click answer; starting from Read only makes changing something the
 * thing a person has to choose to do.
 */
export function signInDefaultScopes(requested: readonly TailnetScope[]): TailnetScope[] {
  const asked = new Set(requested)
  return READ_ONLY_SCOPES.filter((scope) => asked.has(scope))
}

/** A sign-in is granted at most what it asked for: the rows it did not ask for stay unticked. */
export function clampToRequested(scopes: readonly TailnetScope[], requested: readonly TailnetScope[]): TailnetScope[] {
  const asked = new Set(requested)
  return scopes.filter((scope) => asked.has(scope))
}
