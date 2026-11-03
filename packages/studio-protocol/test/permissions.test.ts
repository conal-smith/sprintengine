import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_METHODS,
  STUDIO_TOPICS,
  authorizeStudioMethod,
  authorizeStudioTopic,
  studioRefusedGrantName,
  studioSpecPermissions,
  type StudioMethod,
  type StudioTopic,
} from '../src/methods'
import {
  STUDIO_PERMISSIONS,
  STUDIO_SCOPE_PERMISSIONS,
  authorizeStudioAccess,
  isStudioPermission,
  studioAccessFor,
  studioGrantPrincipal,
  studioPrincipal,
  studioScopeRequires,
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

type Grant = { owner: boolean; scopes: StudioScope[] }

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

test('every method and topic needs the permission its scope names, never less, and only names from the set', () => {
  for (const [name, spec] of [...Object.entries(STUDIO_METHODS), ...Object.entries(STUDIO_TOPICS)]) {
    const needed = studioSpecPermissions(spec)
    for (const permission of needed) assert.equal(isStudioPermission(permission), true, `${name}: ${permission}`)
    for (const permission of spec.extraPermissions ?? [])
      assert.equal(isStudioPermission(permission), true, `${name}: ${permission}`)
    // A method with a scope needs that scope's permission, whatever it adds;
    // only the two that any authenticated client may ask need none.
    if (spec.scope === null) assert.deepEqual(needed, [], name)
    else {
      for (const own of studioScopeRequires(spec.scope))
        assert.ok(needed.includes(own), `${name} needs what "${spec.scope}" names`)
    }
  }
  assert.deepEqual(studioSpecPermissions(STUDIO_METHODS['server.info']), [])
  assert.deepEqual(studioSpecPermissions(STUDIO_METHODS['server.ping']), [])
})

test('a permission a method adds beyond its scope is needed too, and its refusal names it', () => {
  const spec = { scope: 'conversation:operate' as const, extraPermissions: ['filesystem:write' as const] }
  assert.deepEqual(studioSpecPermissions(spec), ['conversation:operate', 'filesystem:write'])
  assert.deepEqual(studioSpecPermissions({ ...spec, extraPermissions: ['conversation:operate'] }), [
    'conversation:operate',
  ])
  // Today's refusals name the scope, as they always have.
  assert.equal(studioRefusedGrantName(spec, 'conversation:operate'), 'conversation:operate')
  assert.equal(studioRefusedGrantName({ scope: 'files:read' }, 'filesystem:read'), 'files:read')
  assert.equal(studioRefusedGrantName(spec, 'filesystem:write'), 'filesystem:write')
  // No method in the table needs more than its scope yet, so every refusal on the wire is unchanged.
  for (const [name, method] of [...Object.entries(STUDIO_METHODS), ...Object.entries(STUDIO_TOPICS)])
    assert.equal(method.extraPermissions, undefined, name)
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
    ...(Object.keys(STUDIO_METHODS) as StudioMethod[]).map(
      (name) => [name, STUDIO_METHODS[name], (grant: Grant) => authorizeStudioMethod(grant, name)] as const,
    ),
    ...(Object.keys(STUDIO_TOPICS) as StudioTopic[]).map(
      (name) => [`topic ${name}`, STUDIO_TOPICS[name], (grant: Grant) => authorizeStudioTopic(grant, name)] as const,
    ),
  ]
  let compared = 0
  for (const scopes of scopeSubsets())
    for (const owner of [false, true]) {
      const grant = { owner, scopes }
      for (const [name, spec, after_] of entries) {
        const before = legacyAllows(grant, spec)
        const after = after_(grant).ok
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
  for (const name of ['conversation.compact', 'constructor', '__proto__'])
    assert.deepEqual(authorizeStudioMethod({ owner: true, scopes: [...STUDIO_SCOPES] }, name), {
      ok: false,
      reason: 'unknown_method',
    })
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
