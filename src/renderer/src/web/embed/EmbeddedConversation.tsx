import React, { useEffect, useMemo, useRef } from 'react'

import type { StudioClient } from '../../../../../packages/agent-sdk/src/index'
import { EmptyState } from '../../components/ui/EmptyState'
import { InlineNotice } from '../../components/ui/InlineNotice'
import type { UserTurn } from '../../components/panels/agentChat/conversationProjection'
import { deriveConversationTimelineRows } from '../../components/panels/agentChat/conversationTimeline'
import {
  ConversationTransportProvider,
  type ConversationTransport,
} from '../../components/panels/agentChat/conversationTransport'
import {
  createConversationProjectionState,
  syncConversationProjection,
} from '../../components/panels/agentChat/incrementalConversationProjection'
import { createStudioChatServices, createStudioConversationParts } from '../../components/panels/agentChat/studioChat'
import { SubagentTypesProvider } from '../../components/panels/agentChat/subagentStatus'
import { TimelineRow, type TimelineChrome } from '../../components/panels/agentChat/timelineRows'
import { useConversationSession } from '../../components/panels/agentChat/useConversationSession'
import { hostPlatform } from '../../clientCapabilities'

// One conversation, read-only, as an embed shows it (phase 9 spec, 5.1, 5.4).
// The rows are the app's own, so a row fixed in the chat is fixed here; the
// transport under them reads and does nothing else. It follows the
// conversation by its workspace and agent only, never by a folder, which is
// an owner's address.

const NO_USER_TURNS: UserTurn[] = []
// The session hook keys a conversation by its folder; the embed's transport
// drops it before anything is sent.
const NO_FOLDER = 'embed'

const READ_ONLY = {
  operate: false,
  startSession: false,
  permanentApprovals: false,
  checkpointRevert: false,
  modelSwitch: false,
  composerContext: false,
  mentions: false,
  attachFiles: false,
  commandList: false,
  imageAttachments: false,
  localHistory: false,
  localFiles: false,
  optimisticTurns: false,
  reportsPreset: false,
  permissionModes: false,
  steer: false,
  hostQueue: false,
  skills: false,
  hostPullRequests: false,
} as const

const refused = async () => ({ ok: false as const, message: 'This view is read-only.' })

function embedTransport(client: StudioClient): ConversationTransport {
  const source = () => Promise.resolve(client)
  const parts = createStudioConversationParts(source)
  // The folder leaves as `undefined`, which the wire drops: the server finds
  // the conversation by its workspace and agent, as it does for any app.
  const noFolder = undefined as unknown as string
  const keyed = <T extends { key: { workspaceRoot: string } }>(input: T): T => ({
    ...input,
    key: { ...input.key, workspaceRoot: noFolder },
  })
  return {
    kind: 'remote',
    capabilities: READ_ONLY,
    subscribe: (input, cb) => parts.subscribe(keyed(input), cb),
    loadEarlier: (input) => parts.loadEarlier(keyed(input)),
    toolDetail: (input) => parts.toolDetail({ ...input, workspaceRoot: noFolder }),
    turnDiff: (input) => parts.turnDiff(keyed(input)),
    send: refused,
    interrupt: refused,
    respond: refused,
    setPermissionPreset: refused,
    services: createStudioChatServices(source),
  }
}

export function EmbeddedConversation({
  client,
  conversation,
  onState,
}: {
  client: StudioClient
  conversation: { workspaceId: string; agentId: string }
  onState?: (state: { turns: number; working: boolean }) => void
}): React.JSX.Element {
  const transport = useMemo(() => embedTransport(client), [client])
  return (
    <ConversationTransportProvider value={transport}>
      <EmbeddedTimeline conversation={conversation} onState={onState} />
    </ConversationTransportProvider>
  )
}

function EmbeddedTimeline({
  conversation,
  onState,
}: {
  conversation: { workspaceId: string; agentId: string }
  onState?: (state: { turns: number; working: boolean }) => void
}): React.JSX.Element {
  const session = useConversationSession(NO_FOLDER, conversation.workspaceId, conversation.agentId)
  const projectionRef = useRef(createConversationProjectionState())
  const projection = useMemo(() => {
    projectionRef.current = syncConversationProjection(projectionRef.current, session.events, NO_USER_TURNS)
    return projectionRef.current.projection
  }, [session.events])
  const previousRowsRef = useRef<ReturnType<typeof deriveConversationTimelineRows>>([])
  const rows = useMemo(() => {
    const next = deriveConversationTimelineRows(projection.entries, projection.activeTurn, previousRowsRef.current)
    previousRowsRef.current = next
    return next
  }, [projection.entries, projection.activeTurn])
  const chrome = useMemo<TimelineChrome>(
    () => ({
      assistantName: 'Agent',
      onRetry: () => undefined,
      retryDisabled: true,
      conversationRunning: projection.activeTurn,
      platform: hostPlatform(),
    }),
    [projection.activeTurn],
  )
  const turns = rows.filter((row) => row.kind === 'user').length
  useEffect(() => onState?.({ turns, working: projection.activeTurn }), [onState, turns, projection.activeTurn])

  if (session.error) return <InlineNotice tone="error" title={session.error} className="m-4" />
  if (session.hydrated && rows.length === 0) return <EmptyState title="This conversation has no messages yet." />
  return (
    <SubagentTypesProvider value={projection.agentTypes}>
      <div role="log" aria-label="Conversation" aria-live="polite" className="chat-column-gutter space-y-1 py-4">
        {rows.map((row) => (
          <div key={row.id} data-embed-turn={row.kind === 'user' ? row.id : undefined}>
            <TimelineRow row={row} chrome={chrome} />
          </div>
        ))}
      </div>
    </SubagentTypesProvider>
  )
}
