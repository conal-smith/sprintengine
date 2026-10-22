import type {
  ConversationEvent,
  ConversationSubscribeInput,
  ConversationSessionFrame,
  ConversationLoadEarlierInput,
  ConversationPageResult,
  ConversationSendTurnInput,
  ConversationInterruptInput,
  ConversationRespondToRequestInput,
  ConversationSetModelInput,
  ConversationSetPermissionInput,
  ConversationTurnDiffInput,
  ConversationRevertInput,
  ConversationRewindInput,
  ConversationHandoffInput,
  ConversationForkInput,
  ConversationListSessionsInput,
  ConversationToolDetailInput,
} from '../shared/conversation-runtime'
import type { ConversationBackend } from '../server/core/conversation-backend'

/** What a router of chats across servers adds (routed-conversation-backend.ts). */
type ResumableBackend = {
  routeOf(workspaceId: string, workspaceRoot?: string): string | null
  onRouteResumed(listener: (key: string) => void): () => void
  onRouteLost?(listener: (key: string, message: string) => void): () => void
}

/** The turn an event belongs to, when it names one. */
function turnIdOf(event: ConversationEvent): string | null {
  const turnId = event.payload?.turnId
  return typeof turnId === 'string' ? turnId : null
}

/** Transport-independent replay, subscription and command boundary. */
export class ConversationSessionApi {
  constructor(private readonly runtime: ConversationBackend) {}
  listSessions(input?: ConversationListSessionsInput) {
    return this.runtime.listSessions(input)
  }
  getToolDetail(input: ConversationToolDetailInput) {
    return this.runtime.getToolDetail(input)
  }
  getTurnDiff(input: ConversationTurnDiffInput) {
    return this.runtime.getTurnDiff(input)
  }
  revertToTurn(input: ConversationRevertInput) {
    return this.runtime.revertToTurn(input)
  }
  rewindToTurn(input: ConversationRewindInput) {
    return this.runtime.rewindToTurn(input)
  }
  handoffConversation(input: ConversationHandoffInput) {
    return this.runtime.handoffConversation(input)
  }
  forkAtTurn(input: ConversationForkInput) {
    return this.runtime.forkAtTurn(input)
  }

  subscribe(
    input: ConversationSubscribeInput,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose: () => void; ready: Promise<void> } {
    let disposed = false
    let joining = true
    let seen = input.afterSeq ?? 0
    let generation = input.generation
    const queued: ConversationEvent[] = []
    let unsubscribe = () => {}
    let stopResume = () => {}
    let stopLost = () => {}
    // The turns this subscriber was shown start and not end, so a server
    // that stops under them can have them shown ended.
    const openTurns = new Map<string, ConversationEvent>()
    const follow = (event: ConversationEvent) => {
      const turnId = turnIdOf(event)
      if (!turnId) return
      if (event.type === 'turn_started' || event.type === 'user_message') {
        if (!openTurns.has(turnId)) openTurns.set(turnId, event)
      } else if (event.type === 'turn_completed' || event.type === 'turn_failed') openTurns.delete(turnId)
    }
    // Set once this subscriber was shown turns closed that the log on disk
    // has not closed yet: the next catch-up is a reset snapshot, so what the
    // server writes when it is back replaces them rather than meets them.
    let closedWhileLost = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      stopResume()
      stopLost()
    }
    const deliver = (frame: ConversationSessionFrame) => {
      if (disposed) return
      if (frame.type === 'event') follow(frame.event)
      else if (frame.type === 'snapshot') {
        openTurns.clear()
        for (const event of frame.page.events) follow(event)
      }
      try {
        listener(frame)
      } catch {
        dispose()
      }
    }
    const live = (event: ConversationEvent) => {
      if (disposed || event.workspaceId !== input.key.workspaceId || event.agentId !== input.key.agentId) return
      if (joining) {
        queued.push(event)
        return
      }
      if ((event.seq ?? 0) <= seen) return
      seen = event.seq!
      deliver({ type: 'event', event })
    }
    /**
     * Read the log from a cursor and hand over what this subscriber lacks,
     * live events held back meanwhile: the first join, and a catch-up after
     * the server holding the chat was out of reach (its wire dropped and came
     * back), using the same cursor and generation rules a client's resubscribe
     * does: the events after the cursor when the log vouches for it, else a
     * reset snapshot.
     */
    const join = async (afterSeq: number | undefined, joinGeneration: string | undefined): Promise<void> => {
      joining = true
      await this.runtime.recoverTranscript(input.key)
      const sync = await this.runtime.readConversationSync(input.key, {
        afterSeq,
        generation: joinGeneration,
        turnLimit: input.turnLimit,
      })
      if (disposed) return
      if (!sync.ok) {
        deliver({ type: 'error', message: sync.message })
        dispose()
        return
      }
      if (sync.kind === 'events') {
        for (const event of sync.events) deliver({ type: 'event', event })
      } else {
        deliver({
          type: 'snapshot',
          page: sync.page,
          generation: sync.generation,
          ...(afterSeq !== undefined ? { reset: true as const } : {}),
        })
      }
      seen = sync.head
      generation = sync.generation
      deliver({ type: 'synchronized', seq: seen, generation: sync.generation })
      joining = false
      for (const event of queued.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) live(event)
      queued.length = 0
    }
    const fail = (error: unknown) => {
      deliver({
        type: 'error',
        message: error instanceof Error ? error.message : 'Conversation could not synchronize.',
      })
      dispose()
    }
    // Subscribe before any asynchronous read so the join has no blind window.
    // An event is published only after it is on disk, so each one either is in
    // the read below or arrives here afterwards; the sequence filter drops the
    // overlap.
    unsubscribe = this.runtime.onEvent(live)
    let joined: Promise<void> = join(input.afterSeq, input.generation)
    const ready = joined.catch(fail)
    // A chat on another server (a WSL distribution's, an SSH machine's): when
    // the wire to it comes back, catch up from where this subscriber is.
    const routed = this.runtime as ConversationBackend & Partial<ResumableBackend>
    if (typeof routed.onRouteResumed === 'function' && typeof routed.routeOf === 'function') {
      stopResume = routed.onRouteResumed((key) => {
        if (disposed || routed.routeOf!(input.key.workspaceId, input.key.workspaceRoot) !== key) return
        const after = closedWhileLost ? undefined : generation
        closedWhileLost = false
        joined = joined.catch(() => undefined).then(() => (disposed ? undefined : join(seen, after)))
        joined.catch(fail)
      })
      // The server holding the chat stopped (it crashed, or WSL was shut
      // down): a turn it was running ended with it. Shown so now, as the
      // runtime shows a turn its app closed under, and not only once the
      // server is started again and reads its log back.
      stopLost =
        routed.onRouteLost?.((key, message) => {
          if (disposed || joining || openTurns.size === 0) return
          if (routed.routeOf!(input.key.workspaceId, input.key.workspaceRoot) !== key) return
          let offset = 0
          for (const [turnId, source] of [...openTurns]) {
            offset++
            deliver({
              type: 'event',
              event: {
                id: `conv_evt_server_lost_${seen}_${offset}`,
                seq: seen + offset,
                sessionId: source.sessionId,
                workspaceId: source.workspaceId,
                agentId: source.agentId,
                providerId: source.providerId,
                modelId: source.modelId,
                type: 'turn_failed',
                createdAt: Date.now(),
                payload: { turnId, reason: 'interrupted', message },
              },
            })
          }
          closedWhileLost = true
        }) ?? (() => {})
    }
    return { dispose, ready }
  }

  async loadEarlier(input: ConversationLoadEarlierInput): Promise<ConversationPageResult> {
    await this.runtime.recoverTranscript(input.key)
    return this.runtime.readConversationPage(input.key, input.beforeCursor, input.turnLimit)
  }

  send(input: ConversationSendTurnInput & { commandId: string }) {
    return this.runtime.sendTurn(input)
  }
  interrupt(input: ConversationInterruptInput & { commandId: string }) {
    return this.runtime.interrupt(input)
  }
  resolveApproval(input: ConversationRespondToRequestInput & { commandId: string }) {
    return this.runtime.respondToRequest(input)
  }
  answerQuestion(input: ConversationRespondToRequestInput & { commandId: string }) {
    return this.runtime.respondToRequest(input)
  }
  setPermissionPreset(input: ConversationSetPermissionInput & { commandId: string }) {
    return this.runtime.setPermission(input)
  }
  setModel(input: ConversationSetModelInput & { commandId: string }) {
    return this.runtime.setModel(input)
  }
}
