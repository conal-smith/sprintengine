import assert from 'node:assert/strict'
import { test } from 'vitest'

import { authorizeStudioAccess, isStudioPermission } from '../../packages/studio-protocol/src/permissions'
import { SERVER_IPC_CHANNELS } from './ipc-channel-owners'
import { WEB_TUNNEL_CHANNELS } from './web-client'
import {
  WEB_OWNER_TUNNEL_PERMISSIONS,
  WEB_TUNNEL_ACCESS,
  webTunnelAllows,
  webTunnelAuthorizes,
  webTunnelPrincipal,
} from './web-tunnel-access'

// The tunnel's rule as it stood, frozen: the domains a tab draws, minus the
// channels that act beyond this server or hand out a credential, plus a few
// reads of domains that otherwise stay on the desktop.
const LEGACY_DOMAINS = new Set([
  'automation',
  'backlog',
  'cli-models',
  'conversation-commands',
  'hosts',
  'launch-settings',
  'workspace-backup',
  'workspace-registry',
  'workspace-sync',
])
const LEGACY_EXCLUDED = new Set([
  'conversation:secrets:set',
  'conversation:secrets:clear',
  'conversation:providers:sign-in',
  'conversation:sessions:terminal-handoff',
  'workspace-sync:set-settled-chats-settings',
  'workspace-sync:set-module-run-states',
])
const LEGACY_SINGLE = new Set([
  'credential:secrets:status',
  'github:token-status',
  'github:list-repos',
  'scheduled-agents:list',
  'scheduled-agents:mark-seen',
  'scheduled-agents:pause-state',
])
function legacyWebTunnelAllows(channel: string): boolean {
  if (Object.hasOwn(WEB_TUNNEL_CHANNELS, channel)) return true
  if (LEGACY_SINGLE.has(channel)) return true
  if (LEGACY_EXCLUDED.has(channel)) return false
  const domain = channel.split(':')[0]
  if (domain === 'conversation') return true
  return LEGACY_DOMAINS.has(domain)
}

const CHANNELS = [...Object.keys(SERVER_IPC_CHANNELS), ...Object.keys(WEB_TUNNEL_CHANNELS)]

test('every channel the server owns and the front door adds says what it needs, or that it is the desktop app’s', () => {
  assert.deepEqual(Object.keys(WEB_TUNNEL_ACCESS).sort(), [...CHANNELS].sort())
  for (const [channel, access] of Object.entries(WEB_TUNNEL_ACCESS)) {
    if ('localOnly' in access) {
      assert.ok(access.localOnly.length > 0, channel)
      continue
    }
    // The tunnel is an owner's: no channel is open to another browser.
    assert.equal(access.owner, true, channel)
    assert.ok(access.permissions.length > 0, channel)
    for (const permission of access.permissions) assert.equal(isStudioPermission(permission), true, channel)
  }
})

test('an owner’s tab reaches exactly the channels it reached before permissions', () => {
  for (const channel of CHANNELS) assert.equal(webTunnelAllows(channel), legacyWebTunnelAllows(channel), channel)
  // The exclusions a tab must keep, among them what main's rest sweep reads
  // that only a desktop window can say.
  for (const channel of [
    'workspace-sync:set-settled-chats-settings',
    'workspace-sync:set-module-run-states',
    'conversation:sessions:terminal-handoff',
    'conversation:secrets:set',
    'tailnet:update-device-scopes',
    'studio-local-apps:offer',
    'mesh:pair',
  ])
    assert.equal(webTunnelAllows(channel), false, channel)
})

test('a name no table holds is refused, even where the old prefix rule would have let it through', () => {
  // These reach no handler: the server registers exactly the channels above
  // (src/server/desktop/server-ipc.test.ts holds it to that).
  for (const channel of ['backlog:drop-everything', 'conversation:sessions:new-thing', 'constructor', '__proto__', ''])
    assert.equal(webTunnelAllows(channel), false, channel)
})

test('a browser that is not the owner reaches no channel at all', () => {
  const guest = webTunnelPrincipal({ owner: false })
  assert.equal(guest.permissions.size, 0)
  for (const channel of CHANNELS) assert.equal(webTunnelAuthorizes(guest, channel), false, channel)
})

test('an owner’s tab holds only the permissions some channel it reaches needs, and nothing for terminals or upkeep', () => {
  const needed = new Set(
    Object.values(WEB_TUNNEL_ACCESS).flatMap((access) => ('permissions' in access ? access.permissions : [])),
  )
  assert.deepEqual([...WEB_OWNER_TUNNEL_PERMISSIONS].sort(), [...needed].sort())
  for (const permission of ['terminal:read', 'terminal:operate', 'environment:maintain', 'tools:offer'])
    assert.equal(WEB_OWNER_TUNNEL_PERMISSIONS.includes(permission as never), false, permission)
  // And the owner principal is refused where a channel is the desktop's, whatever it holds.
  const decision = authorizeStudioAccess(
    webTunnelPrincipal({ owner: true }),
    WEB_TUNNEL_ACCESS['workspace-sync:set-module-run-states'],
  )
  assert.equal(!decision.ok && decision.reason, 'local_only')
})
