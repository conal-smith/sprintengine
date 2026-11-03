import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_METHODS, STUDIO_TOPICS } from '../../packages/studio-protocol/src/methods'
import { STUDIO_PERMISSIONS, type StudioAccess } from '../../packages/studio-protocol/src/permissions'
import {
  CONVERSATION_LANE_ACCESS,
  TAILNET_ROUTE_ACCESS,
  tailnetToolAccess,
} from '../main/automation/tailnet/tailnet-scopes'
import { WEB_HTTP_ACCESS, WEB_TUNNEL_ACCESS } from './web-tunnel-access'

// The permission set across every way into a Studio: each permission is one
// some method needs, or one named for what ships next. A name nothing needs
// is a grant nobody can reason about.

const RESERVED = ['terminal:read', 'terminal:operate', 'environment:maintain']

test('every permission is needed by some remote method, or is named for remote terminals and upkeep', () => {
  const declarations: StudioAccess[] = [
    ...Object.values(STUDIO_METHODS),
    ...Object.values(STUDIO_TOPICS),
    ...Object.values(TAILNET_ROUTE_ACCESS),
    ...Object.values(CONVERSATION_LANE_ACCESS),
    ...Object.values(WEB_TUNNEL_ACCESS),
    ...Object.values(WEB_HTTP_ACCESS),
    // The tool rule's families, read and operate.
    ...['workspace.list', 'backlog.list', 'conversation.list'].flatMap((tool) => [
      tailnetToolAccess(tool, false),
      tailnetToolAccess(tool, true),
    ]),
  ]
  const needed = new Set(declarations.flatMap((access) => ('permissions' in access ? access.permissions : [])))
  for (const permission of STUDIO_PERMISSIONS)
    assert.equal(needed.has(permission) || RESERVED.includes(permission), true, `${permission} is needed by nothing`)
  for (const permission of RESERVED) assert.equal(needed.has(permission as never), false, `${permission} is in use`)
})
