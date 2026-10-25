import { JSDOM } from 'jsdom'
import { forwardRef, Fragment, useImperativeHandle, useRef, type ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import type {
  MeshConversation,
  MeshConversationFrame,
  MeshConversationKey,
  MeshConversationLink,
} from '../../../../../shared/tailnet-mesh'

// The virtual list measures a real viewport, which jsdom does not have; this
// stand-in renders every row.
vi.mock('@legendapp/list/react', () => ({
  LegendList: forwardRef(function LegendList(
    {
      data,
      renderItem,
      keyExtractor,
      className,
    }: {
      data: unknown[]
      renderItem: (props: { item: unknown; index: number }) => ReactNode
      keyExtractor: (item: unknown) => string
      className?: string
    },
    ref,
  ) {
    const scroller = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => ({
      scrollToEnd: async () => undefined,
      scrollToIndex: async () => undefined,
      scrollToOffset: async () => undefined,
      getScrollableNode: () => scroller.current,
      getState: () => ({ positionAtIndex: () => 0, positionByKey: () => 0 }),
    }))
    return (
      <div ref={scroller} className={className}>
        {data.map((item, index) => (
          <Fragment key={keyExtractor(item)}>{renderItem({ item, index })}</Fragment>
        ))}
      </div>
    )
  }),
}))

// Decoding an image needs a real <img> and canvas, which jsdom lacks; what the
// pane does with the decoded attachment is what these tests drive.
vi.mock('./imageAttachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./imageAttachments')>()),
  readImageAttachment: async (file: File, id: string) => ({
    id,
    mediaType: file.type || 'image/png',
    dataBase64: 'iVBORw0KGgo=',
    name: file.name,
    byteLength: 8,
  }),
}))

const key: MeshConversationKey = {
  connectionId: 'connection',
  workspaceId: 'remote-workspace',
  agentId: 'remote-agent',
}

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'remote-session',
    workspaceId: key.workspaceId,
    agentId: key.agentId,
    providerId: 'claude-agent',
    modelId: 'opus',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

const thread: MeshConversation = {
  workspaceId: key.workspaceId,
  agentId: key.agentId,
  title: 'Fix the flaky upload test',
  phase: 'waiting_for_approval',
  updatedAt: 5,
  createdAt: 1,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 9,
  sessionId: 'remote-session',
  capabilities: { images: true, approvals: true, questions: true, planMode: true, interrupt: true, checkpoints: true },
}

// Mounts the remote pane against a scripted Mesh API. The local
// conversation API is absent altogether: nothing in this view may reach it.
async function mountRemote({
  access,
  permissionPreset,
  models,
  modelSwitch = false,
  permissionModes = false,
  queuedSends = false,
  steerSends = false,
  stopSubagents = false,
  handoff = false,
  sendSkills = false,
  capabilities = thread.capabilities,
  listed = {},
  createPullRequest = false,
}: {
  access: 'read' | 'operate'
  permissionPreset?: MeshConversation['permissionPreset']
  models?: MeshConversation['models']
  modelSwitch?: boolean
  permissionModes?: boolean
  queuedSends?: boolean
  steerSends?: boolean
  /** The machine stops one agent of a chat by itself (`conversation-stop-subagent`). */
  stopSubagents?: boolean
  /** The machine hands its chats off to a fresh session (`conversation-handoff`). */
  handoff?: boolean
  /** The machine takes skills with a message (`conversation-send-skills`). */
  sendSkills?: boolean
  /** What the machine lists the chat as able to do; null for a chat at rest there, listed with no session. */
  capabilities?: MeshConversation['capabilities'] | null
  /** More of what the machine lists about the chat: its branch, changed files, worktree and pull requests. */
  listed?: Partial<Pick<MeshConversation, 'branch' | 'pullRequests' | 'changes' | 'worktree'>>
  /** The machine opens pull requests for its chats (`chat-create-pull-request`). */
  createPullRequest?: boolean
}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const receivers: Array<(frame: MeshConversationFrame) => void> = []
  const followed: MeshConversationKey[] = []
  // The model the machine says the chat is on: what an accepted switch moves.
  let listedModel = thread.modelId
  // What the machine lists once a Create PR there has recorded one as the chat's.
  let recordedPullRequests: NonNullable<MeshConversation['pullRequests']> | null = null
  const api = {
    platform: 'darwin',
    meshConversationList: vi.fn(async () => ({
      ok: true,
      conversations: [
        {
          ...thread,
          ...(capabilities ? { capabilities } : { capabilities: undefined, sessionId: undefined }),
          modelId: listedModel,
          ...(permissionPreset ? { permissionPreset } : {}),
          ...(models ? { models } : {}),
          ...listed,
          ...(recordedPullRequests ? { pullRequests: recordedPullRequests } : {}),
        },
      ],
      access,
      modelSwitch,
      permissionModes,
      queuedSends,
      steerSends,
      stopSubagents,
      handoff,
      sendSkills,
      createPullRequest,
    })),
    // Create PR on the machine the chat runs on: each step answers as that
    // machine would, and a creation records the pull request there.
    meshConversationPullRequestState: vi.fn(async (_input: { key: MeshConversationKey }) => ({
      ok: true,
      state: {
        readiness: { ready: true },
        gitRoot: null,
        branch: 'agent/remote-pr',
        headSha: 'abc1234def',
        uncommittedChanges: 2,
        base: 'main',
        forge: 'github',
      },
    })),
    meshConversationPullRequestDraft: vi.fn(async (_input: { key: MeshConversationKey; draftId?: string }) => ({
      ok: true,
      title: 'feat: create a pull request from a paired machine',
      body: 'Drafted over there.',
    })),
    meshConversationPullRequestDraftCancel: vi.fn(async () => ({ ok: true })),
    meshConversationPullRequestPush: vi.fn(async (_input: { key: MeshConversationKey; pin?: unknown }) => ({
      ok: true,
      pushed: true,
    })),
    meshConversationPullRequestCreate: vi.fn(
      async (_input: { key: MeshConversationKey; title: string; body: string; pin?: unknown }) => {
        recordedPullRequests = [
          {
            number: 290,
            state: 'open',
            url: 'https://github.com/acme/studio/pull/290',
            title: 'feat: create a pull request from a paired machine',
          },
        ]
        return {
          ok: true,
          kind: 'created',
          url: 'https://github.com/acme/studio/pull/290',
          recorded: { ok: true },
        }
      },
    ),
    onMeshConversationSession: vi.fn(
      (input: { key: MeshConversationKey }, receive: (frame: MeshConversationFrame) => void) => {
        followed.push(input.key)
        receivers.push(receive)
        return () => undefined
      },
    ),
    // A turn's changed files are listed as soon as its card is drawn.
    meshConversationTurnDiff: vi.fn(async () => ({
      ok: true,
      diff: {
        files: [{ path: 'src/upload.ts', status: 'modified', addedLines: 1, removedLines: 1, binary: false }],
        submodulesExcluded: true,
      },
    })),
    meshConversationSend: vi.fn(
      async (_input: {
        key: MeshConversationKey
        message: string
        attachments?: unknown[]
        queue?: boolean
        steer?: boolean
      }): Promise<{ ok: true } | { ok: false; code: string; message: string }> => ({ ok: true }),
    ),
    meshConversationCancelQueued: vi.fn(async (_input: { key: MeshConversationKey; queuedId: string }) => ({
      ok: true,
    })),
    meshConversationResolveApproval: vi.fn(async () => ({ ok: true })),
    meshConversationInterrupt: vi.fn(async () => ({ ok: true })),
    meshConversationHandoff: vi.fn(async (_input: { key: MeshConversationKey }) => ({ ok: true as const })),
    meshConversationStopSubagent: vi.fn(async (_input: { key: MeshConversationKey; toolUseId: string }) => ({
      ok: true,
    })),
    meshConversationSetPermissionPreset: vi.fn(async () => ({ ok: true })),
    meshConversationSetModel: vi.fn(async (input: { key: MeshConversationKey; modelId: string }) => {
      listedModel = input.modelId
      return { ok: true, notice: 'The new model starts with your next message.' }
    }),
  }
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api,
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: RemoteConversationPanel } = await import('./RemoteConversationPanel')
  const { EditorView } = await import('@codemirror/view')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(RemoteConversationPanel, {
        workspaceId: 'local-workspace',
        connectionId: key.connectionId,
        machineName: 'mac-mini',
        remoteWorkspaceId: key.workspaceId,
        remoteAgentId: key.agentId,
      }),
    ),
  )
  const earlier = event('user_message', { turnId: 'earlier', text: 'Bump the timeout' })
  const events = [
    earlier,
    event('turn_started', { turnId: 'earlier' }),
    event('content_delta', { turnId: 'earlier', text: 'Raised it to ten seconds.' }),
    event('turn_completed', {
      turnId: 'earlier',
      checkpointTurnSeq: earlier.seq,
      checkpointAvailable: true,
      checkpointSummary: { files: 1, addedLines: 1, removedLines: 1 },
    }),
    event('user_message', { turnId: 'a', text: 'Why does the upload test flake?' }),
    event('turn_started', { turnId: 'a' }),
    event('content_delta', { turnId: 'a', text: 'Let me run it.' }),
    event('approval_requested', {
      turnId: 'a',
      requestId: 'approval-1',
      action: 'Bash',
      summary: 'npm test',
      input: { command: 'npm test' },
    }),
  ]
  const link: MeshConversationLink = { type: 'link', state: 'live', detail: 'Following on mac-mini.', access }
  await act(async () => {
    const receive = receivers.at(-1)!
    receive({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null }, generation: 'g' })
    receive({ type: 'synchronized', seq: events.at(-1)!.seq!, generation: 'g' })
    receive(link)
  })
  // The composer is an editor: its editable element takes the keys, and the
  // draft is the editor's document.
  const composer = () => host.querySelector<HTMLElement>('.cm-content')!
  const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  return {
    host,
    document: dom.window.document,
    act,
    api,
    followed,
    emit: (frame: MeshConversationFrame) => receivers.at(-1)!(frame),
    button: (label: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label),
    type: (value: string) => {
      const view = editor()
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: value.length },
        userEvent: 'input.type',
      })
    },
    enter: () =>
      composer().dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    composer,
    draft: () => editor().state.doc.toString(),
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const name of Object.keys(globals)) {
        if (previous[name]) Object.defineProperty(globalThis, name, previous[name])
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

test('the strip under a paired machine’s chat names its branch, its changed files and its pull request, as a local chat’s does', async () => {
  const chat = await mountRemote({
    access: 'operate',
    listed: {
      branch: 'agent/chat-5v54',
      worktree: true,
      changes: { added: 3, updated: 2, removed: 1, scope: 'worktree' },
      pullRequests: [
        { number: 283, state: 'open', url: 'https://github.com/acme/studio/pull/283', title: 'Remote parity' },
      ],
    },
  })
  try {
    const strip = chat.host.querySelector('[data-conversation-strip]')!
    expect(strip.querySelector('[data-strip-branch="agent/chat-5v54"]')).not.toBeNull()
    expect(strip.querySelector('[data-strip-pull-request-slot]')?.textContent).toContain('283')
    // The files that machine counted, as "+5 −1", and the worktree it names.
    expect(strip.querySelector('[aria-label^="3 files added, 2 updated, 1 removed"]')).not.toBeNull()
    expect(strip.querySelector('[data-strip-branch]')?.getAttribute('aria-label')).toContain('in a worktree')
  } finally {
    await chat.unmount()
  }
})

test('a conversation on a paired machine renders in the chat view and is driven over the mesh', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    expect(chat.followed).toEqual([key])
    expect(chat.host.textContent).toContain('Why does the upload test flake?')
    expect(chat.host.textContent).toContain('Let me run it.')
    // No header line above the transcript repeats the agent and the machine:
    // the tab and the strip below say them (owner, 2026-10-08).
    expect(chat.host.textContent).not.toContain('· On mac-mini')

    // An approval is answered over the mesh, and no rule that would outlive
    // the conversation is offered.
    expect(chat.host.textContent).not.toMatch(/always/i)
    await chat.act(async () => chat.button('Allow once')!.click())
    expect(chat.api.meshConversationResolveApproval).toHaveBeenCalledWith({
      key,
      requestId: 'approval-1',
      decision: 'once',
    })

    // Neither the model nor the permission preset of a conversation over
    // there is this machine's to pick. The "+" is drawn because the machine
    // lists this chat as taking images, which go over with the message; a
    // chat that does not take them draws none (below).
    expect(chat.host.querySelector('[data-composer-options]')).not.toBeNull()
    // The strip under the composer marks the machine the chat runs on with its
    // glyph alone, named in its tooltip and accessible name; this computer has
    // no checkout of it, so no branch and no counts.
    const machine = chat.host.querySelector('[data-conversation-strip] [data-strip-machine]')
    expect(machine?.getAttribute('aria-label')).toBe('On mac-mini')
    expect(machine?.textContent).toBe('')
    expect(chat.host.querySelector('[data-conversation-strip] [data-strip-branch]')).toBeNull()
    expect(chat.host.querySelector('[data-conversation-strip] [data-diff-stat-pill]')).toBeNull()
    // A turn's changes can be read, but its files are on the other machine's
    // disk, so nothing offers to revert them.
    expect(chat.host.textContent).toContain('1 file changed')
    expect(chat.host.textContent).not.toContain('Revert to before this turn')
    // Its tree is listed, but the diff window and the editor open this disk's files.
    expect(chat.host.querySelector('[aria-label^="src/upload.ts, modified"]')).not.toBeNull()
    expect(chat.host.querySelector('[aria-label="Open diff"]')).toBeNull()
    expect(chat.host.querySelector('[aria-label="Open src/upload.ts"]')).toBeNull()
    // A machine whose list does not name the preset in force gets no switcher:
    // a picker showing a guess would be worse than none.
    expect(chat.host.textContent).not.toContain('Bypass permissions')
    expect(chat.host.textContent).not.toContain('CLI default')
  } finally {
    await chat.unmount()
  }
})

test('an approval over there can be allowed for the rest of the conversation, never for good', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: true }) })
      chat.emit({
        type: 'event',
        event: event('approval_requested', {
          turnId: 'a',
          requestId: 'approval-2',
          action: 'Bash',
          summary: 'git status',
          input: { command: 'git status' },
          // The folder the request runs in on that machine.
          cwd: '/Users/conal/project',
        }),
      })
    })
    await chat.act(async () =>
      chat.host.querySelector<HTMLButtonElement>('button[aria-label="Remember permission"]')!.click(),
    )
    const rows = Array.from(chat.document.querySelectorAll<HTMLElement>('[data-menu-item="true"]'))
    expect(rows.map((row) => row.textContent?.trim())).toEqual(['Allow "git status …" for this conversation'])
    await chat.act(async () => rows[0]!.click())
    expect(chat.api.meshConversationResolveApproval).toHaveBeenCalledWith({
      key,
      requestId: 'approval-2',
      decision: 'conversation',
    })
  } finally {
    await chat.unmount()
  }
})

test('a send goes to the machine that holds the conversation, with no session started here', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    // The turn is still waiting on its approval, so a send queues; answering
    // lets it through, as it would on the desktop itself.
    await chat.act(async () => chat.type('Try it with --runInBand'))
    await chat.act(async () => chat.enter())
    expect(chat.host.textContent).toContain('Queued')
    await chat.act(async () => chat.button('Deny')!.click())
    expect(chat.api.meshConversationResolveApproval).toHaveBeenCalledWith({
      key,
      requestId: 'approval-1',
      decision: 'deny',
    })
    expect(chat.api.meshConversationSend).not.toHaveBeenCalled()
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: false }) })
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'a' }) })
    })
    expect(chat.api.meshConversationSend).toHaveBeenCalledExactlyOnceWith({ key, message: 'Try it with --runInBand' })
    // No optimistic bubble: the machine's own `user_message` is the one shown.
    expect(chat.host.textContent?.match(/Try it with --runInBand/g) ?? []).toHaveLength(0)
    await chat.act(async () =>
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'b', text: 'Try it with --runInBand' }) }),
    )
    expect(chat.host.textContent?.match(/Try it with --runInBand/g) ?? []).toHaveLength(1)
  } finally {
    await chat.unmount()
  }
})

test('a message queued for a machine that holds its own queue is handed to it at once, and shown from what it holds', async () => {
  const chat = await mountRemote({ access: 'operate', queuedSends: true })
  try {
    await chat.act(async () => chat.type('Try it with --runInBand'))
    await chat.act(async () => chat.enter())
    // Handed over now, mid-turn, so it goes even if this machine sleeps.
    expect(chat.api.meshConversationSend).toHaveBeenCalledExactlyOnceWith({
      key,
      message: 'Try it with --runInBand',
      queue: true,
    })
    expect(chat.draft()).toBe('')
    await chat.act(async () =>
      chat.emit({
        type: 'queued',
        messages: [{ id: 'sm-1', text: 'Try it with --runInBand', createdAt: 1_700_000_000_000 }],
      }),
    )
    const row = chat.host.querySelector('[aria-label="Queued message"]')
    expect(row?.textContent).toContain('Queued')
    expect(row?.textContent).toContain('Try it with --runInBand')
    // The turn ending here sends nothing from here: that machine sends it.
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: false }) })
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'a' }) })
    })
    expect(chat.api.meshConversationSend).toHaveBeenCalledTimes(1)
    // Edit takes it back from there into this composer.
    await chat.act(async () => chat.button('Edit')!.click())
    expect(chat.api.meshConversationCancelQueued).toHaveBeenCalledExactlyOnceWith({ key, queuedId: 'sm-1' })
    expect(chat.draft()).toBe('Try it with --runInBand')
    await chat.act(async () => chat.emit({ type: 'queued', messages: [] }))
    expect(chat.host.querySelector('[aria-label="Queued message"]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

/** Mounts a chat whose turn runs on (its card answered), with a message the machine holds for its end. */
async function holdingMessage(options: { steerSends: boolean }) {
  const chat = await mountRemote({
    access: 'operate',
    queuedSends: true,
    steerSends: options.steerSends,
    capabilities: { ...thread.capabilities!, steer: options.steerSends },
  })
  await chat.act(async () =>
    chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: true }) }),
  )
  await chat.act(async () => chat.type('Keep the print styles square'))
  await chat.act(async () => chat.enter())
  expect(chat.api.meshConversationSend).toHaveBeenLastCalledWith({
    key,
    message: 'Keep the print styles square',
    queue: true,
  })
  await chat.act(async () =>
    chat.emit({
      type: 'queued',
      messages: [{ id: 'sm-1', text: 'Keep the print styles square', createdAt: 1_700_000_000_000 }],
    }),
  )
  return chat
}

test('Send now on a message the machine holds takes it back and steers it in, and the turn is not stopped', async () => {
  const chat = await holdingMessage({ steerSends: true })
  try {
    await chat.act(async () => chat.button('Send now')!.click())
    expect(chat.api.meshConversationCancelQueued).toHaveBeenCalledExactlyOnceWith({ key, queuedId: 'sm-1' })
    expect(chat.api.meshConversationSend).toHaveBeenLastCalledWith({
      key,
      message: 'Keep the print styles square',
      steer: true,
    })
    expect(chat.api.meshConversationInterrupt).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('Primary+Enter with nothing typed steers in the message the machine holds', async () => {
  const chat = await holdingMessage({ steerSends: true })
  try {
    await chat.act(async () =>
      chat.composer().dispatchEvent(
        new chat.document.defaultView!.KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(chat.api.meshConversationCancelQueued).toHaveBeenCalledExactlyOnceWith({ key, queuedId: 'sm-1' })
    expect(chat.api.meshConversationSend).toHaveBeenLastCalledWith({
      key,
      message: 'Keep the print styles square',
      steer: true,
    })
    expect(chat.api.meshConversationInterrupt).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('a held message that could not be taken back is left to that machine, and the turn is not stopped', async () => {
  const chat = await holdingMessage({ steerSends: true })
  chat.api.meshConversationCancelQueued.mockImplementationOnce(async () => ({
    ok: false,
    message: 'That message is already on its way into the chat.',
  }))
  try {
    await chat.act(async () => chat.button('Send now')!.click())
    expect(chat.api.meshConversationSend).toHaveBeenCalledTimes(1)
    expect(chat.api.meshConversationInterrupt).not.toHaveBeenCalled()
    expect(chat.host.textContent).toContain('That message is already on its way into the chat.')
  } finally {
    await chat.unmount()
  }
})

test('a machine that takes no steer offers Stop and send for the message it holds, which stops the turn', async () => {
  const chat = await holdingMessage({ steerSends: false })
  try {
    expect(chat.button('Send now')).toBeUndefined()
    await chat.act(async () => chat.button('Stop and send')!.click())
    expect(chat.api.meshConversationInterrupt).toHaveBeenCalledOnce()
    expect(chat.api.meshConversationCancelQueued).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

/** Starts an agent in the turn the mounted chat is running, as that machine's events say. */
async function startAgent(chat: Awaited<ReturnType<typeof mountRemote>>) {
  await chat.act(async () =>
    chat.emit({
      type: 'event',
      event: event('tool_started', {
        turnId: 'a',
        toolUseId: 'toolu_agent',
        name: 'Agent',
        subagentLane: true,
        subagentType: 'general',
        input: { description: 'Restyle the boxes' },
      }),
    }),
  )
}
const agentStops = (chat: Awaited<ReturnType<typeof mountRemote>>) =>
  chat.host.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop this agent"]')

test('an agent in a chat over there has a Stop of its own, which stops that agent and not the turn', async () => {
  const chat = await mountRemote({
    access: 'operate',
    stopSubagents: true,
    capabilities: { ...thread.capabilities!, stopSubagent: true },
  })
  try {
    await startAgent(chat)
    expect(agentStops(chat)).toHaveLength(1)
    await chat.act(async () => agentStops(chat)[0]!.click())
    expect(chat.api.meshConversationStopSubagent).toHaveBeenCalledExactlyOnceWith({ key, toolUseId: 'toolu_agent' })
    expect(chat.api.meshConversationInterrupt).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('no Stop on an agent where the machine cannot stop one by itself, or lists its chat as unable', async () => {
  for (const options of [
    { stopSubagents: false, capabilities: { ...thread.capabilities!, stopSubagent: true } },
    { stopSubagents: true, capabilities: { ...thread.capabilities!, stopSubagent: false } },
    { stopSubagents: true, capabilities: thread.capabilities },
  ]) {
    const chat = await mountRemote({ access: 'operate', ...options })
    try {
      await startAgent(chat)
      expect(chat.host.textContent).toContain('Restyle the boxes')
      expect(agentStops(chat)).toHaveLength(0)
    } finally {
      await chat.unmount()
    }
  }
})

test('a pairing that may only follow sees no Stop on an agent', async () => {
  const chat = await mountRemote({
    access: 'read',
    stopSubagents: true,
    capabilities: { ...thread.capabilities!, stopSubagent: true },
  })
  try {
    await startAgent(chat)
    expect(agentStops(chat)).toHaveLength(0)
  } finally {
    await chat.unmount()
  }
})

/** What the composer's "+" offers, by each row's words. */
async function optionsMenu(chat: Awaited<ReturnType<typeof mountRemote>>): Promise<string[]> {
  const plus = chat.host.querySelector<HTMLButtonElement>('button[aria-label="Options"]')
  expect(plus, 'the composer has its "+"').not.toBeNull()
  await chat.act(async () => plus!.click())
  return Array.from(document.querySelectorAll<HTMLElement>('[data-menu-item="true"]')).map(
    (row) => row.textContent?.trim() ?? '',
  )
}

test('a chat over there offers that machine\'s skills from the "+", where it takes them with a message', async () => {
  const takes = await mountRemote({ access: 'operate', sendSkills: true })
  try {
    expect((await optionsMenu(takes)).some((row) => row.startsWith('Skills'))).toBe(true)
  } finally {
    await takes.unmount()
  }
  const older = await mountRemote({ access: 'operate', sendSkills: false })
  try {
    expect((await optionsMenu(older)).some((row) => row.startsWith('Skills'))).toBe(false)
  } finally {
    await older.unmount()
  }
})

/** The chat's cache went cold long ago, with the whole conversation to re-read. */
async function coldCache(chat: Awaited<ReturnType<typeof mountRemote>>) {
  await settleTurn(chat)
  await chat.act(async () => {
    chat.emit({
      type: 'event',
      event: event('usage_updated', { promptCache: { ttl: '5m', cached: true, recacheTokens: 221_000 } }),
    })
  })
}
const handoffButton = (chat: Awaited<ReturnType<typeof mountRemote>>) =>
  Array.from(chat.host.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === 'Handoff',
  )

test('a cold chat over there offers Handoff, which that machine carries out', async () => {
  const chat = await mountRemote({
    access: 'operate',
    handoff: true,
    capabilities: { ...thread.capabilities!, handoff: true },
  })
  try {
    await coldCache(chat)
    const button = handoffButton(chat)
    expect(button, 'the cache notice leads with Handoff').toBeDefined()
    await chat.act(async () => button!.click())
    expect(chat.api.meshConversationHandoff).toHaveBeenCalledExactlyOnceWith({ key })
  } finally {
    await chat.unmount()
  }
})

test('no Handoff where the machine cannot hand a chat off, lists its chat as unable, or the pairing only follows', async () => {
  for (const options of [
    { access: 'operate' as const, handoff: false, capabilities: { ...thread.capabilities!, handoff: true } },
    { access: 'operate' as const, handoff: true, capabilities: { ...thread.capabilities!, handoff: false } },
    { access: 'operate' as const, handoff: true, capabilities: thread.capabilities },
    { access: 'read' as const, handoff: true, capabilities: { ...thread.capabilities!, handoff: true } },
  ]) {
    const chat = await mountRemote(options)
    try {
      await coldCache(chat)
      expect(handoffButton(chat)).toBeUndefined()
    } finally {
      await chat.unmount()
    }
  }
})

/** Settles the turn the mounted chat is waiting on, so a send goes at once rather than queueing. */
async function settleTurn(chat: Awaited<ReturnType<typeof mountRemote>>) {
  await chat.act(async () => {
    chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: true }) })
    chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'a' }) })
  })
}

/** A drop of files from the system, each with its path on this disk. */
function dropFiles(
  chat: Awaited<ReturnType<typeof mountRemote>>,
  files: Array<{ name: string; type: string; path: string }>,
) {
  const dropped = files.map((file) => new File(['x'], file.name, { type: file.type }))
  const paths = new Map(dropped.map((file, index) => [file, files[index]!.path]))
  Object.assign(chat.api, {
    getPathForFile: (file: File) => paths.get(file) ?? '',
    attachFile: (file: File) => paths.get(file) ?? '',
  })
  const drop = new chat.document.defaultView!.MouseEvent('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', {
    value: {
      types: ['Files'],
      items: dropped.map((file) => ({ kind: 'file', getAsFile: () => file })),
      files: dropped,
      getData: () => '',
    },
  })
  chat.composer().dispatchEvent(drop)
  return drop
}

test('an image dropped on a chat over there that takes images is attached, and goes with the message over the mesh', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    await settleTurn(chat)
    let drop: Event | undefined
    await chat.act(async () => {
      drop = dropFiles(chat, [{ name: 'shot.png', type: 'image/png', path: '/Users/dev/Desktop/shot.png' }])
    })
    expect(drop!.defaultPrevented, 'the drop is claimed, not handed to the field').toBe(true)
    expect(chat.composer().textContent, 'the path is not typed into the message').not.toContain('/Users/dev')
    expect(chat.host.querySelector('[aria-label="Remove shot.png"]'), 'the image waits in the composer').not.toBeNull()
    await chat.act(async () => chat.type('What is wrong here?'))
    await chat.act(async () => chat.enter())
    expect(chat.api.meshConversationSend).toHaveBeenCalledExactlyOnceWith({
      key,
      message: 'What is wrong here?',
      attachments: [expect.objectContaining({ mediaType: 'image/png', name: 'shot.png', dataBase64: 'iVBORw0KGgo=' })],
    })
  } finally {
    await chat.unmount()
  }
})

test('a message the machine could not hold waits here, and goes from here when the turn ends', async () => {
  const chat = await mountRemote({ access: 'operate', queuedSends: true })
  try {
    chat.api.meshConversationSend.mockResolvedValueOnce({
      ok: false,
      code: 'unavailable',
      message: 'This chat already holds as many queued messages as it can.',
    })
    await chat.act(async () => chat.type('Try it with --runInBand'))
    await chat.act(async () => chat.enter())
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('Try it with --runInBand')
    expect(chat.host.textContent).toContain('mac-mini could not hold the message')
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: false }) })
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'a' }) })
    })
    expect(chat.api.meshConversationSend).toHaveBeenLastCalledWith({ key, message: 'Try it with --runInBand' })
  } finally {
    await chat.unmount()
  }
})

test('a chat over there that does not take images offers none, and a dropped image is typed as its path', async () => {
  const chat = await mountRemote({ access: 'operate', capabilities: { ...thread.capabilities!, images: false } })
  try {
    await settleTurn(chat)
    // Nothing else goes in the "+" for a chat over there, so with no images it is not drawn.
    expect(chat.host.querySelector('[data-composer-options]')).toBeNull()
    await chat.act(async () => {
      dropFiles(chat, [{ name: 'shot.png', type: 'image/png', path: '/Users/dev/Desktop/shot.png' }])
    })
    expect(chat.composer().textContent).toContain('/Users/dev/Desktop/shot.png')
    expect(chat.host.querySelector('[aria-label="Remove shot.png"]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('a chat at rest over there is read again once its first message is answered, to learn whether it takes images', async () => {
  const chat = await mountRemote({ access: 'operate', capabilities: null })
  try {
    await settleTurn(chat)
    expect(
      chat.host.querySelector('[data-composer-options]'),
      'a chat listed without a session offers no images',
    ).toBeNull()
    const reads = chat.api.meshConversationList.mock.calls.length
    await chat.act(async () => chat.type('Wake up'))
    await chat.act(async () => chat.enter())
    expect(chat.api.meshConversationSend).toHaveBeenCalledExactlyOnceWith({ key, message: 'Wake up' })
    expect(chat.api.meshConversationList.mock.calls.length).toBe(reads + 1)
  } finally {
    await chat.unmount()
  }
})

test('a pairing that may only follow sees the conversation with every action closed', async () => {
  const chat = await mountRemote({ access: 'read' })
  try {
    expect(chat.host.textContent).toContain('Let me run it.')
    expect(chat.host.textContent).toContain('may follow this conversation on mac-mini but not drive it')
    expect(chat.composer().getAttribute('contenteditable')).toBe('false')
    expect(chat.button('Deny')?.disabled).toBe(true)
    expect(chat.button('Allow once')?.disabled).toBe(true)
    expect(chat.host.querySelector('[aria-label="Stop responding"]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

// The chat's permissions are on the engine picker's trailing row, as a
// launch's are: opened through the engine chip when the picker is not open.
const permissionsChip = async (chat: Awaited<ReturnType<typeof mountRemote>>) => {
  const find = () =>
    Array.from(chat.document.querySelectorAll('button')).find((item) =>
      item.getAttribute('aria-label')?.startsWith('Permissions:'),
    )
  if (!find()) await chat.act(async () => engineChip(chat.host)!.click())
  return find()
}

test('a chat on a machine that runs only two presets dims the other two, and a pick goes over the mesh', async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'bypass' })
  try {
    // Bypass is a safeguard off: the engine chip says so while the picker
    // holding the permissions is closed.
    expect(engineChip(chat.host)?.getAttribute('aria-label')).toMatch(/— Permissions: Bypass permissions$/)
    expect(engineChip(chat.host)?.getAttribute('data-engine-warn')).toBe('true')
    // The permissions sit on the engine picker's trailing row.
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: Bypass permissions')
    const chip = await permissionsChip(chat)
    await chat.act(async () => chip!.click())
    const rows = Array.from(chat.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]'))
    expect(rows).toHaveLength(4)
    // An older machine reads Manual and Auto as No flag, so neither is offered
    // as if it would hold, and each says why. Strictest first, No flag last.
    expect(rows.map((row) => row.disabled)).toEqual([true, true, false, false])
    expect(rows[0]!.textContent).toContain('mac-mini needs a newer Studio for this.')
    await chat.act(async () => rows[3]!.click())
    expect(chat.api.meshConversationSetPermissionPreset).toHaveBeenCalledExactlyOnceWith({ key, preset: 'none' })
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: No flag')
  } finally {
    await chat.unmount()
  }
})

test('a chat on a machine that runs all four presets offers them, and Auto goes over the mesh', async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'none', permissionModes: true })
  try {
    const chip = await permissionsChip(chat)
    await chat.act(async () => chip!.click())
    const rows = Array.from(chat.document.querySelectorAll<HTMLButtonElement>('[data-preset-option="true"]'))
    expect(rows.map((row) => row.disabled)).toEqual([false, false, false, false])
    await chat.act(async () => rows[1]!.click())
    expect(chat.api.meshConversationSetPermissionPreset).toHaveBeenCalledExactlyOnceWith({ key, preset: 'auto' })
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: Auto')
  } finally {
    await chat.unmount()
  }
})

test("a permission card's Allow and switch allows that request first, then moves the chat over the mesh", async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'none', permissionModes: true })
  try {
    const order: string[] = []
    chat.api.meshConversationResolveApproval.mockImplementation(async () => {
      order.push('allow')
      return { ok: true }
    })
    chat.api.meshConversationSetPermissionPreset.mockImplementation(async () => {
      order.push('switch')
      return { ok: true }
    })
    const menu = Array.from(chat.host.querySelectorAll('button')).find(
      (item) => item.getAttribute('aria-label') === 'More ways to allow',
    )
    expect(menu).toBeDefined()
    await chat.act(async () => menu!.click())
    const row = (label: string) =>
      Array.from(chat.document.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
    // Looser than No flag, and runnable there: Auto and Bypass.
    expect(row('Allow and switch to Auto')).toBeDefined()
    await chat.act(async () => row('Allow and switch to Bypass permissions')!.click())
    expect(chat.api.meshConversationResolveApproval).toHaveBeenCalledExactlyOnceWith({
      key,
      requestId: 'approval-1',
      decision: 'once',
    })
    expect(chat.api.meshConversationSetPermissionPreset).toHaveBeenCalledExactlyOnceWith({ key, preset: 'bypass' })
    expect(order).toEqual(['allow', 'switch'])
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: Bypass permissions')
  } finally {
    await chat.unmount()
  }
})

test('a refused allow leaves the chat on the mode it was on', async () => {
  const chat = await mountRemote({ access: 'operate', permissionPreset: 'none', permissionModes: true })
  try {
    chat.api.meshConversationResolveApproval.mockImplementation(async () => ({
      ok: false,
      code: 'invalid',
      message: 'This request has already been answered.',
    }))
    const menu = Array.from(chat.host.querySelectorAll('button')).find(
      (item) => item.getAttribute('aria-label') === 'More ways to allow',
    )
    await chat.act(async () => menu!.click())
    const row = Array.from(chat.document.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Allow and switch to Auto',
    )
    await chat.act(async () => row!.click())
    expect(chat.api.meshConversationSetPermissionPreset).not.toHaveBeenCalled()
    expect(chat.host.textContent).toContain('This request has already been answered.')
    expect((await permissionsChip(chat))?.getAttribute('aria-label')).toBe('Permissions: No flag')
  } finally {
    await chat.unmount()
  }
})

// The catalog the machine lists for the chat's CLI. This machine's own catalog
// for that CLI is empty here, so every model row the picker shows is the
// machine's.
const remoteModels: NonNullable<MeshConversation['models']> = {
  cli: 'claude-code',
  cliLabel: 'Claude Code',
  liveModelSwitch: true,
  options: [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
}

const engineChip = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('button')).find((item) => item.getAttribute('aria-label')?.startsWith('Engine:'))

test("a chat on a machine that offers model switching lists that machine's models, and a pick goes over the mesh", async () => {
  const chat = await mountRemote({ access: 'operate', models: remoteModels, modelSwitch: true })
  try {
    expect(engineChip(chat.host)?.textContent).toContain('Opus')
    await chat.act(async () => engineChip(chat.host)!.click())
    const rows = () => Array.from(chat.document.querySelectorAll<HTMLElement>('[data-model-row="true"]'))
    expect(rows().some((row) => row.textContent?.includes('Sonnet'))).toBe(true)
    const listReads = chat.api.meshConversationList.mock.calls.length
    await chat.act(async () =>
      rows()
        .find((row) => row.textContent?.includes('Sonnet'))!
        .click(),
    )
    expect(chat.api.meshConversationSetModel).toHaveBeenCalledExactlyOnceWith({ key, modelId: 'sonnet' })
    // The chip names the model the machine accepted, the machine is asked
    // again, and its word that the switch waits for the next turn is shown.
    expect(engineChip(chat.host)?.textContent).toContain('Sonnet')
    expect(chat.api.meshConversationList.mock.calls.length).toBeGreaterThan(listReads)
    expect(chat.host.textContent).toContain('The new model starts with your next message.')
  } finally {
    await chat.unmount()
  }
})

test('a machine that does not offer model switching keeps the chat on its model, whatever its list carries', async () => {
  const chat = await mountRemote({ access: 'operate', models: remoteModels, modelSwitch: false })
  try {
    await chat.act(async () => engineChip(chat.host)!.click())
    const rows = Array.from(chat.document.querySelectorAll<HTMLElement>('[data-model-row="true"]'))
    expect(rows.some((row) => row.textContent?.includes('Sonnet'))).toBe(false)
    expect(chat.api.meshConversationSetModel).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('a link that drops does not list the machine; one that comes back live does', async () => {
  const chat = await mountRemote({ access: 'operate' })
  try {
    const reads = () => chat.api.meshConversationList.mock.calls.length
    const before = reads()
    await chat.act(async () =>
      chat.emit({ type: 'link', state: 'reconnecting', detail: 'Reconnecting to mac-mini.', access: 'operate' }),
    )
    await chat.act(async () =>
      chat.emit({ type: 'link', state: 'offline', detail: 'mac-mini is not answering.', access: 'operate' }),
    )
    expect(reads()).toBe(before)
    await chat.act(async () =>
      chat.emit({ type: 'link', state: 'live', detail: 'Following on mac-mini.', access: 'operate' }),
    )
    expect(reads()).toBe(before + 1)
  } finally {
    await chat.unmount()
  }
})

test('a steer to a chat over there clears once its message is in, and a failure after that brings back nothing', async () => {
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.getState().setFollowUpBehavior('steer')
  const chat = await mountRemote({
    access: 'operate',
    steerSends: true,
    capabilities: { ...thread.capabilities!, steer: true },
  })
  let settleFirst: (result: { ok: false; code: string; message: string }) => void = () => undefined
  chat.api.meshConversationSend.mockImplementationOnce(
    () => new Promise((resolve) => (settleFirst = resolve as typeof settleFirst)),
  )
  try {
    // The card is answered: the turn runs on, and can take a message.
    await chat.act(async () =>
      chat.emit({ type: 'event', event: event('approval_resolved', { requestId: 'approval-1', approved: true }) }),
    )
    await chat.act(async () => chat.type('Keep it to one file'))
    await chat.act(async () => chat.enter())
    expect(chat.api.meshConversationSend).toHaveBeenLastCalledWith({ key, message: 'Keep it to one file', steer: true })
    // Its message arrives over there, with no id of this window's on it.
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'a', steered: true }) })
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'b', text: 'Keep it to one file' }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 'b' }) })
    })
    // Delivered, so the next message may steer too rather than wait behind it.
    await chat.act(async () => chat.type('And the docs'))
    await chat.act(async () => chat.enter())
    expect(chat.api.meshConversationSend).toHaveBeenLastCalledWith({ key, message: 'And the docs', steer: true })
    // The turn it opened fails: the words are in the chat, not back in the composer.
    await chat.act(async () => settleFirst({ ok: false, code: 'unavailable', message: 'The turn failed.' }))
    expect(chat.draft()).toBe('')
  } finally {
    useWorkspaceStore.getState().setFollowUpBehavior('queue')
    await chat.unmount()
  }
})

test('a paired machine that opens pull requests offers Create PR, and every step runs over there', async () => {
  const chat = await mountRemote({ access: 'operate', createPullRequest: true, listed: { branch: 'agent/remote-pr' } })
  try {
    const createButton = () =>
      Array.from(chat.host.querySelectorAll('button')).find((item) => item.textContent?.includes('Create PR'))
    // The machine is asked whether the chat's checkout is ready, by the chat's key.
    expect(chat.api.meshConversationPullRequestState).toHaveBeenCalledWith({ key })
    expect(createButton()?.getAttribute('aria-label')).toBe('Create a pull request from this branch')

    await chat.act(async () => createButton()!.click())
    // The draft is written over there, with that machine's settings.
    expect(chat.api.meshConversationPullRequestDraft).toHaveBeenCalledWith(expect.objectContaining({ key }))
    const title = chat.document.querySelector<HTMLInputElement>('input[maxlength="300"]')!
    expect(title.value).toBe('feat: create a pull request from a paired machine')
    // What the checkout over there leaves out is said as it is for a local chat.
    expect(chat.document.querySelector('[data-create-pull-request-uncommitted]')?.textContent).toContain(
      '2 uncommitted changes',
    )

    const listReads = chat.api.meshConversationList.mock.calls.length
    const create = Array.from(chat.document.querySelectorAll('button')).find((item) => item.textContent === 'Create')
    await chat.act(async () => create!.click())
    const pin = { branch: 'agent/remote-pr', headSha: 'abc1234def' }
    expect(chat.api.meshConversationPullRequestPush).toHaveBeenCalledWith({ key, pin })
    expect(chat.api.meshConversationPullRequestCreate).toHaveBeenCalledWith({
      key,
      title: 'feat: create a pull request from a paired machine',
      body: 'Drafted over there.',
      pin,
    })
    // The machine recorded it; the list is read again and the slot is that pull request's.
    expect(chat.api.meshConversationList.mock.calls.length).toBeGreaterThan(listReads)
    expect(chat.host.querySelector('[data-create-pull-request-error]')).toBeNull()
    expect(chat.host.querySelector('[data-strip-pull-request-slot]')?.textContent).toContain('290')
  } finally {
    await chat.unmount()
  }
})

test('no Create PR for a machine that does not open pull requests, or a pairing that may only follow', async () => {
  for (const options of [
    { access: 'operate' as const, createPullRequest: false },
    { access: 'read' as const, createPullRequest: true },
  ]) {
    const chat = await mountRemote({ ...options, listed: { branch: 'agent/remote-pr' } })
    try {
      expect(chat.api.meshConversationPullRequestState).not.toHaveBeenCalled()
      expect(
        Array.from(chat.host.querySelectorAll('button')).some((item) => item.textContent?.includes('Create PR')),
      ).toBe(false)
    } finally {
      await chat.unmount()
    }
  }
})
