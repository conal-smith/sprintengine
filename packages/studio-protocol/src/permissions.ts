import { STUDIO_SCOPES, type StudioScope } from './scopes.js'

// What a remote caller may do, named once for every way into a Studio: the
// Studio protocol (local apps, browsers, embeds), the tailnet gateway (another
// desktop, the phone) and a browser tab's tunnel.
//
// A grant is still stored and sent under the names it was made with (the
// Studio scopes in `scopes.ts`, the tailnet's own, a browser's owner flag), so
// a record written by an older build reads the same, and an older peer is
// answered as before. Those names are translated to permissions where a
// request is judged, from the grant as it stands then; each method names the
// permissions it needs; and one function, `authorizeStudioAccess`, decides.
//
// A permission is a closed name. A principal holds exactly the set it was
// given: nothing implies anything at check time, so what a grant reaches is
// read off its translation and nowhere else.

/** Every permission this version of the protocol defines. */
export const STUDIO_PERMISSIONS = [
  // Follow chats: list, read, their pictures and diffs.
  'conversation:read',
  // Drive a chat that exists: send, answer, interrupt, change its model.
  'conversation:operate',
  // Start a chat.
  'conversation:create',
  // The workspace list and the app-wide state around it.
  'workspace:read',
  // Change workspaces and that state; the home of a mutation nothing more specific names.
  'workspace:operate',
  'backlog:read',
  'backlog:operate',
  // The providers and models a chat can run, and whether a key is set.
  'providers:read',
  // Files on this machine: search, stat, read, the folder browser.
  'filesystem:read',
  'filesystem:write',
  // Give Studio's agents tools of the client's own.
  'tools:offer',
  // Change this machine's settings.
  'settings:write',
  // Open a preview of a server an agent runs here.
  'preview:operate',
  // See and change who may reach this machine: paired browsers, embeds, endpoints.
  'access:read',
  'access:write',
  // Remote terminals and keeping this machine's Studio itself: named so the
  // methods that need them declare them when they ship. No method requires
  // them yet and no grant that exists today carries them.
  'terminal:read',
  'terminal:operate',
  'environment:maintain',
] as const

export type StudioPermission = (typeof STUDIO_PERMISSIONS)[number]

/** Whether a value names a permission this version of the protocol defines. */
export function isStudioPermission(value: unknown): value is StudioPermission {
  return (STUDIO_PERMISSIONS as readonly unknown[]).includes(value)
}

/**
 * What one method asks of its caller.
 *
 * Either the permissions it needs, all of them, and whether only an owner's
 * connection may call it at all; or that it is not served remotely, whatever
 * a caller holds, with the reason a refusal says.
 */
export type StudioAccess =
  { readonly permissions: readonly StudioPermission[]; readonly owner?: true } | { readonly localOnly: string }

/** Who is asking, as far as authorization goes: whether it is an owner, and what it holds. */
export type StudioPrincipal = { readonly owner: boolean; readonly permissions: ReadonlySet<StudioPermission> }

export type StudioAuthorization =
  | { ok: true }
  | { ok: false; reason: 'unknown_method' }
  | { ok: false; reason: 'local_only'; message: string }
  | { ok: false; reason: 'owner_required' }
  | { ok: false; reason: 'permission_required'; permission: StudioPermission }

/**
 * A method's access from its table, or undefined for a name the table does not
 * hold. Own keys only: `constructor` or `__proto__` is not a method.
 */
export function studioAccessFor(table: Readonly<Record<string, StudioAccess>>, name: string): StudioAccess | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined
}

/**
 * The decision: deny by default.
 *
 * No declaration is an unknown method. Then a local-only method, which no
 * grant reaches; then the owner's methods; then the first permission the
 * principal lacks, in the order the method names them, so a refusal names
 * the broadest thing missing first.
 */
export function authorizeStudioAccess(
  principal: StudioPrincipal,
  access: StudioAccess | undefined,
): StudioAuthorization {
  if (!access) return { ok: false, reason: 'unknown_method' }
  if ('localOnly' in access) return { ok: false, reason: 'local_only', message: access.localOnly }
  if (access.owner && !principal.owner) return { ok: false, reason: 'owner_required' }
  for (const permission of access.permissions)
    if (!principal.permissions.has(permission)) return { ok: false, reason: 'permission_required', permission }
  return { ok: true }
}

/** A principal holding exactly these permissions. */
export function studioPrincipal(input: { owner: boolean; permissions: Iterable<StudioPermission> }): StudioPrincipal {
  const held = new Set<StudioPermission>()
  for (const permission of input.permissions) if (isStudioPermission(permission)) held.add(permission)
  return { owner: input.owner, permissions: held }
}

// ── Studio scopes ───────────────────────────────────────────────────────────

/**
 * What each Studio scope a grant holds carries. `conversation:operate` carries
 * `conversation:read`, as it always has: a client that drives a chat can see
 * what it is driving. Every other scope carries the one permission it names.
 */
export const STUDIO_SCOPE_PERMISSIONS: { readonly [S in StudioScope]: readonly StudioPermission[] } = {
  'conversation:read': ['conversation:read'],
  'conversation:operate': ['conversation:read', 'conversation:operate'],
  'conversation:create': ['conversation:create'],
  'providers:read': ['providers:read'],
  'files:read': ['filesystem:read'],
  'workspaces:read': ['workspace:read'],
  'tools:offer': ['tools:offer'],
  'files:write': ['filesystem:write'],
}

/** The permission each Studio scope is the grant name for. */
const STUDIO_SCOPE_NAMES: { readonly [S in StudioScope]: StudioPermission } = {
  'conversation:read': 'conversation:read',
  'conversation:operate': 'conversation:operate',
  'conversation:create': 'conversation:create',
  'providers:read': 'providers:read',
  'files:read': 'filesystem:read',
  'workspaces:read': 'workspace:read',
  'tools:offer': 'tools:offer',
  'files:write': 'filesystem:write',
}

/**
 * What a method a client reaches under `scope` needs: the permission that
 * scope names. The method tables declare through this, so a method's scope
 * (what a client asks to be granted) and its permissions (what is checked)
 * cannot disagree; a method that needs more spells its permissions out.
 */
export function studioScopeRequires(scope: StudioScope): readonly StudioPermission[] {
  return [STUDIO_SCOPE_NAMES[scope]]
}

/** The principal a Studio grant is: its owner flag, and what its scopes carry. Unknown scope names carry nothing. */
export function studioGrantPrincipal(grant: { owner: boolean; scopes: readonly string[] }): StudioPrincipal {
  const held = new Set(grant.scopes)
  return studioPrincipal({
    owner: grant.owner,
    permissions: STUDIO_SCOPES.filter((scope) => held.has(scope)).flatMap((scope) => STUDIO_SCOPE_PERMISSIONS[scope]),
  })
}
