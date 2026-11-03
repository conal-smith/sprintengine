import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_METHODS, STUDIO_TOPICS, type StudioMethod, type StudioTopic } from '../src/methods'
import {
  STUDIO_PERMISSIONS,
  STUDIO_SCOPE_PERMISSIONS,
  authorizeStudioAccess,
  isStudioPermission,
  studioAccessFor,
  studioGrantPrincipal,
  studioPrincipal,
  type StudioAccess,
} from '../src/permissions'
import { STUDIO_SCOPES, type StudioScope } from '../src/scopes'

// The check as it stood before permissions, frozen here as the oracle the new
// one must agree with: a scope covers itself, and operate covers read.
function legacyStudioScopesGrant(scopes: readonly string[], needed: StudioScope): boolean {
  if (scopes.includes(needed)) return true
  return needed === 'conversation:read' && scopes.includes('conversation:operate')
}
function legacyAllows(
  grant: { owner: boolean; scopes: StudioScope[] },
  spec: { scope: StudioScope | null; owner?: true },
) {
  if (spec.owner && !grant.owner) return false
  return spec.scope === null || legacyStudioScopesGrant(grant.scopes, spec.scope)
}

function* scopeSubsets(): Generator<StudioScope[]> {
  for (let mask = 0; mask < 1 << STUDIO_SCOPES.length; mask++)
    yield STUDIO_SCOPES.filter((_scope, index) => (mask & (1 << index)) !== 0)
}

test('the permission set is closed: each name once, and nothing outside it is one', () => {
  assert.equal(new Set(STUDIO_PERMISSIONS).size, STUDIO_PERMISSIONS.length)
  for (const permission of STUDIO_PERMISSIONS) assert.equal(isStudioPermission(permission), true, permission)
  for (const value of ['conversation:admin', 'terminal:observe', 'files:read', '', null, 7, 'constructor'])
    assert.equal(isStudioPermission(value), false, String(value))
})

test('every method and topic declares the permissions it needs, from the closed set', () => {
  for (const [name, spec] of [...Object.entries(STUDIO_METHODS), ...Object.entries(STUDIO_TOPICS)]) {
    assert.ok(Array.isArray(spec.permissions), name)
    for (const permission of spec.permissions)
      assert.equal(isStudioPermission(permission), true, `${name}: ${permission}`)
    // A method with a scope needs a permission; only the two that any
    // authenticated client may ask need none.
    if (spec.scope === null) assert.deepEqual(spec.permissions, [], name)
    else assert.ok(spec.permissions.length > 0, name)
  }
  assert.deepEqual(STUDIO_METHODS['server.info'].permissions, [])
  assert.deepEqual(STUDIO_METHODS['server.ping'].permissions, [])
})

test('every Studio scope a grant can hold carries only permissions from the closed set', () => {
  for (const scope of STUDIO_SCOPES) {
    assert.ok(STUDIO_SCOPE_PERMISSIONS[scope].length > 0, scope)
    for (const permission of STUDIO_SCOPE_PERMISSIONS[scope]) assert.equal(isStudioPermission(permission), true, scope)
  }
  // Nothing a grant made today holds reaches a terminal, settings, or this machine's upkeep.
  const carried = new Set(STUDIO_SCOPES.flatMap((scope) => STUDIO_SCOPE_PERMISSIONS[scope]))
  for (const permission of [
    'terminal:read',
    'terminal:operate',
    'settings:write',
    'environment:maintain',
    'access:write',
  ])
    assert.equal(carried.has(permission as never), false, permission)
})

test('every grant reaches exactly the methods and topics it reached before permissions', () => {
  // All 256 sets of scopes, owner and not, against every method and topic.
  const entries = [
    ...(Object.keys(STUDIO_METHODS) as StudioMethod[]).map((name) => [name, STUDIO_METHODS[name]] as const),
    ...(Object.keys(STUDIO_TOPICS) as StudioTopic[]).map((name) => [`topic ${name}`, STUDIO_TOPICS[name]] as const),
  ]
  let compared = 0
  for (const scopes of scopeSubsets())
    for (const owner of [false, true]) {
      const grant = { owner, scopes }
      const principal = studioGrantPrincipal(grant)
      for (const [name, spec] of entries) {
        const before = legacyAllows(grant, spec)
        const after = authorizeStudioAccess(principal, spec).ok
        assert.equal(after, before, `${name} for ${owner ? 'an owner' : 'a client'} holding [${scopes.join(', ')}]`)
        compared++
      }
    }
  assert.ok(compared > 256 * 2 * 50)
})

test('an unknown method is refused, and so is a name only the prototype has', () => {
  const owner = studioPrincipal({ owner: true, permissions: STUDIO_PERMISSIONS })
  assert.deepEqual(authorizeStudioAccess(owner, undefined), { ok: false, reason: 'unknown_method' })
  for (const name of ['conversation.compact', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ''])
    assert.equal(studioAccessFor(STUDIO_METHODS, name), undefined, name)
  assert.equal(authorizeStudioAccess(owner, studioAccessFor(STUDIO_METHODS, 'constructor')).ok, false)
  assert.equal(studioAccessFor(STUDIO_METHODS, 'conversation.send'), STUDIO_METHODS['conversation.send'])
})

test('the decision: local-only before owner, owner before permissions, the first missing permission named', () => {
  const nobody = studioPrincipal({ owner: false, permissions: [] })
  const everyone = studioPrincipal({ owner: true, permissions: STUDIO_PERMISSIONS })
  const localOnly: StudioAccess = { localOnly: 'Run it on that machine.' }
  assert.deepEqual(authorizeStudioAccess(everyone, localOnly), {
    ok: false,
    reason: 'local_only',
    message: 'Run it on that machine.',
  })
  const owned: StudioAccess = { permissions: ['conversation:operate'], owner: true }
  assert.deepEqual(authorizeStudioAccess(nobody, owned), { ok: false, reason: 'owner_required' })
  assert.deepEqual(
    authorizeStudioAccess(studioPrincipal({ owner: false, permissions: STUDIO_PERMISSIONS }), owned),
    { ok: false, reason: 'owner_required' },
    'every permission is still not the owner',
  )
  const both: StudioAccess = { permissions: ['conversation:read', 'conversation:operate'] }
  assert.deepEqual(authorizeStudioAccess(nobody, both), {
    ok: false,
    reason: 'permission_required',
    permission: 'conversation:read',
  })
  assert.deepEqual(authorizeStudioAccess(studioPrincipal({ owner: false, permissions: ['conversation:read'] }), both), {
    ok: false,
    reason: 'permission_required',
    permission: 'conversation:operate',
  })
  assert.deepEqual(authorizeStudioAccess(nobody, { permissions: [] }), { ok: true })
})

test('a grant is translated by its scopes alone: unknown names carry nothing, and nothing is implied later', () => {
  const principal = studioGrantPrincipal({ owner: false, scopes: ['conversation:operate', 'terminal:observe', 'x'] })
  assert.deepEqual([...principal.permissions].sort(), ['conversation:operate', 'conversation:read'])
  assert.equal(principal.owner, false)
  assert.deepEqual([...studioGrantPrincipal({ owner: true, scopes: [] }).permissions], [])
  // A principal built from names outside the set holds none of them.
  assert.deepEqual([...studioPrincipal({ owner: false, permissions: ['nope' as never] }).permissions], [])
})
