import { JSDOM } from 'jsdom'
import { forwardRef, memo, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionFrame,
  ConversationSubscribeInput,
} from '../../../../../shared/conversation-runtime'
import { installStudioLoopback } from '../../../../../../tests/studio-chat-loopback'

// The virtual list measures a real viewport, which jsdom does not have; this
// stand-in renders every row so the rows themselves can be driven. Like the
// real list, a row on screen renders again only when its item or the list's
// `extraData` changes: a new `renderItem` alone does not reach it. Where it
// was asked to scroll to is kept, for what lands the view on a row, and where
// it was told to start when it mounted.
const scrolledToIndex = vi.hoisted(() => [] as { index: number; viewPosition?: number }[])
const mountedAt = vi.hoisted(() => [] as { initialScrollIndex?: number; initialScrollAtEnd?: boolean }[])
const listedKeys = vi.hoisted(() => ({ current: [] as string[] }))
const ListRow = memo(
  function ListRow({
    item,
    index,
    render,
  }: {
    item: unknown
    index: number
    extraData: unknown
    render: (props: { item: unknown; index: number }) => ReactNode
  }) {
    return <>{render({ item, index })}</>
  },
  (previous, next) => previous.item === next.item && previous.extraData === next.extraData,
)
vi.mock('@legendapp/list/react', () => ({
  LegendList: forwardRef(function LegendList(
    {
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      className,
      extraData,
      initialScrollIndex,
      initialScrollAtEnd,
    }: {
      data: unknown[]
      renderItem: (props: { item: unknown; index: number }) => ReactNode
      keyExtractor: (item: unknown) => string
      ListHeaderComponent?: ReactNode
      className?: string
      extraData?: unknown
      initialScrollIndex?: number
      initialScrollAtEnd?: boolean
    },
    ref,
  ) {
    const scroller = useRef<HTMLDivElement>(null)
    // Read once, as the real list reads them.
    useState(() => mountedAt.push({ initialScrollIndex, initialScrollAtEnd }))
    listedKeys.current = data.map(keyExtractor)
    useImperativeHandle(ref, () => ({
      scrollToEnd: async () => undefined,
      scrollToIndex: async (target: { index: number; viewPosition?: number }) => {
        scrolledToIndex.push({ index: target.index, viewPosition: target.viewPosition })
      },
      scrollToOffset: async () => undefined,
      getScrollableNode: () => scroller.current,
      getState: () => ({ positionAtIndex: () => 0, positionByKey: () => 0 }),
    }))
    return (
      <div ref={scroller} className={className}>
        {ListHeaderComponent}
        {data.map((item, index) => (
          <ListRow key={keyExtractor(item)} item={item} index={index} extraData={extraData} render={renderItem} />
        ))}
      </div>
    )
  }),
}))

// Decoding an image needs a real <img> and canvas, which jsdom lacks; what the
// composer does with the decoded attachment is what these tests drive.
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

// The composer's "+" menu, counted each time its memo lets a render through:
// a wrapper with the same shallow comparison the menu's own memo makes.
const plusMenuRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../workspace/agentComposer/ComposerPlusMenu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace/agentComposer/ComposerPlusMenu')>()
  const { createElement, memo } = await import('react')
  return {
    ...actual,
    ComposerPlusMenu: memo(function CountedComposerPlusMenu(
      props: import('react').ComponentProps<typeof actual.ComposerPlusMenu>,
    ) {
      plusMenuRenders.count++
      return createElement(actual.ComposerPlusMenu, props)
    }),
  }
})

type SendTurn = (input: {
  mode?: string
  message?: string
  sessionId?: string
}) => Promise<{ ok: boolean; message?: string }>

// Mounts the whole chat view against a scripted conversation API, the way a
// person meets it: a transcript arrives over the session subscription and the
// composer and rows are driven through the DOM.
async function mountChat({
  events = [],
  capabilities = {},
  providerId = 'mock',
  modelId = 'mock-model',
  providerModels = [{ id: modelId }],
  agent: agentPatch = {},
  sendTurn = async () => ({ ok: false, message: 'Not scripted.' }),
  setModel,
  plugins,
  api: extraApi = {},
  cliModelCatalog,
  whenActive = false,
  folderPath = '/Users/dev/project',
  worktree,
  beforeRender,
}: {
  events?: ConversationEvent[]
  capabilities?: Record<string, unknown>
  providerId?: string
  modelId?: string
  providerModels?: { id: string; displayName?: string; contextLength?: number }[]
  agent?: Record<string, unknown>
  sendTurn?: SendTurn
  setModel?: (input: { sessionId: string; modelId: string }) => Promise<unknown>
  plugins?: unknown[]
  /** More of the window's api: git reads for the strip, say. */
  api?: Record<string, unknown>
  cliModelCatalog?: Record<string, unknown>
  /** Draw the chat only while it is the window's active one, as the window does. */
  whenActive?: boolean
  /** The chat's folder, which keys the transcript the window keeps for it. */
  folderPath?: string | null
  /** The chat's worktree marker. */
  worktree?: Record<string, unknown>
  /** What happens once the store holds the chat and before it is drawn. */
  beforeRender?: () => void
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
  const frames: ((frame: ConversationSessionFrame) => void)[] = []
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: {
      platform: 'darwin',
      onConversationSession: (
        _input: ConversationSubscribeInput,
        receive: (frame: ConversationSessionFrame) => void,
      ) => {
        frames.push(receive)
        return () => undefined
      },
      conversationProvidersList: async () => ({
        ok: true,
        providers: [
          {
            id: providerId,
            displayName: providerId === 'mock' ? 'Mock' : 'Claude Code',
            providerType: providerId === 'mock' ? 'model-provider' : 'agent-harness',
            models: providerModels,
            capabilities,
          },
        ],
      }),
      conversationSecretStatus: async () => ({ ok: false, message: 'No secret' }),
      conversationSessionStart: async () => ({
        ok: true,
        session: {
          sessionId: 'session',
          workspaceId: 'workspace',
          agentId: 'agent',
          providerId,
          modelId,
          status: 'ready',
          createdAt: 1,
          updatedAt: 1,
          capabilities,
        },
      }),
      conversationSessionSendTurn: sendTurn,
      conversationThreads: async () => ({ ok: true, threads: [] }),
      ...(setModel ? { conversationSessionSetModel: setModel } : {}),
      ...extraApi,
    },
  })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const { default: AgentChatView } = await import('../AgentChatView')
  const { EditorView } = await import('@codemirror/view')
  const { composerDraftStore } = await import('./draftStore')
  composerDraftStore().getState().remove('workspace', 'agent')
  if (plugins)
    useWorkspaceStore.setState({ pluginCatalogEntries: plugins as never, pluginCatalogStatus: 'ready' as never })
  if (cliModelCatalog)
    useWorkspaceStore.setState((state) => ({
      appSettings: { ...state.appSettings, cliModelCatalog: cliModelCatalog as never },
    }))
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace',
        name: 'Project',
        folderPath,
        ...(worktree ? { worktree } : {}),
        agents: {
          agent: {
            id: 'agent',
            name: 'Chat',
            runtimeKind: 'conversation',
            conversation: { providerId, modelId },
            ...agentPatch,
          },
        },
      },
    ] as never,
  })
  beforeRender?.()
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const chatView = () => createElement(AgentChatView, { workspaceId: 'workspace', agentId: 'agent' })
  function FrontChat() {
    return useWorkspaceStore((state) => state.activeWorkspaceId) === 'workspace' ? chatView() : null
  }
  if (whenActive) useWorkspaceStore.setState({ activeWorkspaceId: null } as never)
  await act(async () => root.render(whenActive ? createElement(FrontChat) : chatView()))
  await act(async () => {
    frames.at(-1)?.({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
    frames.at(-1)?.({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
  })
  // The composer is an editor: its editable element takes the keys and the
  // events, and the draft is the editor's document.
  const field = () => host.querySelector<HTMLElement>('.cm-content')!
  const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  return {
    dom,
    host,
    act,
    agent: () => useWorkspaceStore.getState().workspaces[0].agents.agent,
    emit: (frame: ConversationSessionFrame) => frames.at(-1)?.(frame),
    button: (label: string) =>
      Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes(label)),
    field,
    draft: () => editor().state.doc.toString(),
    caret: () => editor().state.selection.main.head,
    type: (value: string) => {
      const view = editor()
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: value.length },
        userEvent: 'input.type',
      })
    },
    enter: () =>
      field().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock',
    modelId: 'mock-model',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

test('a turn goes out in the default mode: the chat has no plan toggle', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: false, message: 'The provider is restarting.' }))
  // Even an agent record left on plan mode by an older build sends a default
  // turn: plan mode has no control here any more, so it cannot be a state.
  const chat = await mountChat({ capabilities: { planMode: true }, agent: { conversationMode: 'plan' }, sendTurn })
  try {
    expect(chat.button('Plan')).toBeUndefined()
    await chat.act(async () => chat.type('Plan the migration'))
    await chat.act(async () => chat.enter())
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ mode: 'default', message: 'Plan the migration' })
    expect(chat.host.textContent).toContain('The provider is restarting.')
  } finally {
    await chat.unmount()
  }
})

test('a markdown draft is drawn formatted in the composer, and goes out as the markdown it was typed as', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn })
  const draft = '# Handoff\n- Every worktree is **synced** with `main`'
  try {
    await chat.act(async () => chat.type(draft))
    const lines = Array.from(chat.field().querySelectorAll('.cm-line'))
    expect(lines[0].classList.contains('cm-md-heading'), 'the heading line is drawn as a heading').toBe(true)
    expect(lines[0].textContent, 'its hashes are off the line while the caret is elsewhere').toBe('Handoff')
    expect(lines[1].textContent).toBe('• Every worktree is synced with main')
    expect(chat.field().querySelector('.cm-md-strong')?.textContent).toBe('synced')
    expect(chat.field().querySelector('.cm-md-code')?.textContent).toBe('main')
    await chat.act(async () => chat.enter())
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: draft })
  } finally {
    await chat.unmount()
  }
})

test('the launcher’s prompt is sent as the first message the moment the chat is ready', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({ agent: { chatStartupPrompt: 'hi' }, sendTurn })
  try {
    await chat.act(async () => undefined)
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: 'hi' })
    expect(chat.agent().chatStartupPrompt, 'one-shot: a remount never sends it twice').toBeUndefined()
    expect(chat.draft(), 'nothing is left in the composer for a second Enter').toBe('')
  } finally {
    await chat.unmount()
  }
})

// The launcher's prompt is on screen as its pending bubble before it is sent;
// its row takes that bubble's place without the entrance a new row plays.
test('the launcher’s prompt lands in place of its pending bubble, while a typed message slides in', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({ agent: { chatStartupPrompt: 'hi' }, sendTurn })
  const userFrame = (text: string) =>
    Array.from(chat.host.querySelectorAll('[data-conversation-row-kind="user"]')).find((row) =>
      row.textContent?.includes(text),
    )?.parentElement
  try {
    await chat.act(async () => undefined)
    expect(userFrame('hi'), 'the first message is drawn').toBeDefined()
    expect(userFrame('hi')?.className ?? '').not.toContain('conversation-row-enter')

    await chat.act(async () => chat.type('and again'))
    await chat.act(async () => void chat.enter())
    expect(userFrame('and again')?.className).toContain('conversation-row-enter')
  } finally {
    await chat.unmount()
  }
})

// The launcher holds a staged screenshot as a file; macOS's own thumbnail sits
// in a temporary folder like this one.
const LAUNCH_SHOT = '/var/folders/x1/T/TemporaryItems/NSIRD_screencaptureui_ab12/Screenshot 2026-10-04 at 12.15.13.png'

test('the launcher’s images go with the first message as images, the way a later message’s do', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const readImageDataUrl = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=')
  const chat = await mountChat({
    capabilities: { images: true },
    agent: { chatStartupPrompt: 'It looks wrong', chatStartupImages: [LAUNCH_SHOT] },
    sendTurn,
    api: { readImageDataUrl },
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(readImageDataUrl).toHaveBeenCalledWith(LAUNCH_SHOT)
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({
      message: 'It looks wrong',
      attachments: [{ mediaType: 'image/png', name: 'Screenshot 2026-10-04 at 12.15.13.png' }],
    })
    expect(chat.agent().chatStartupImages, 'one-shot, with the prompt').toBeUndefined()
  } finally {
    await chat.unmount()
  }
})

test('a chat whose provider reads no images is given the launcher’s image paths after the text', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const readImageDataUrl = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=')
  const chat = await mountChat({
    agent: { chatStartupPrompt: 'It looks wrong', chatStartupImages: [LAUNCH_SHOT] },
    sendTurn,
    api: { readImageDataUrl },
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(readImageDataUrl).not.toHaveBeenCalled()
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: `It looks wrong '${LAUNCH_SHOT}'` })
    expect(sendTurn.mock.calls[0][0]).not.toHaveProperty('attachments')
  } finally {
    await chat.unmount()
  }
})

// A New chat on a worktree opens before its worktree exists
// (utils/newChatWorktree.ts): no folder, its project in the marker, and its
// agent waiting on the worktree.
const PENDING_PROJECT = '/Users/dev/project'
const PENDING_WORKTREE = '/Users/dev/.sprintengine-worktrees/project/chat-ab12'

function deferredWorktree() {
  let settle: (result: unknown) => void = () => undefined
  const createGitWorktree = vi.fn(
    (input: { destinationPath: string; branchName: string }) =>
      new Promise((resolve) => {
        settle = (result) =>
          resolve(
            result === 'ok'
              ? { ok: true, data: { path: PENDING_WORKTREE, branch: input.branchName, baseRef: 'main' } }
              : result,
          )
      }),
  )
  return { createGitWorktree, settle: (result: unknown) => settle(result) }
}

async function mountPendingChat(options: {
  createGitWorktree: (input: { destinationPath: string; branchName: string }) => Promise<unknown>
  startAttempt: boolean
  sendTurn: SendTurn
  conversationSessionStart: ReturnType<typeof vi.fn>
}) {
  const { prepareNewChatWorktree } = await import('../../../utils/newChatWorktree')
  return mountChat({
    folderPath: null,
    worktree: { repoRoot: PENDING_PROJECT },
    agent: {
      chatStartupPrompt: 'fix the login',
      chatPendingWorktree: { name: '', projectFolder: PENDING_PROJECT },
    },
    sendTurn: options.sendTurn,
    api: {
      getGitRepoRoot: async () => PENDING_PROJECT,
      createGitWorktree: options.createGitWorktree,
      conversationSessionStart: options.conversationSessionStart,
    },
    // The confirm starts the attempt as it creates the chat, before its first frame.
    beforeRender: options.startAttempt ? () => void prepareNewChatWorktree('workspace') : undefined,
  })
}

function sessionStartSpy() {
  return vi.fn(async (input: { workspaceRoot: string }) => ({
    ok: true,
    session: {
      sessionId: 'session',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock',
      modelId: 'mock-model',
      status: 'ready',
      createdAt: 1,
      updatedAt: 1,
      capabilities: {},
      workspaceRoot: input.workspaceRoot,
    },
  }))
}

test('a chat waiting on its worktree shows the prompt as its bubble, working, and starts nothing until the folder is set', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const conversationSessionStart = sessionStartSpy()
  const worktree = deferredWorktree()
  const chat = await mountPendingChat({
    createGitWorktree: worktree.createGitWorktree,
    startAttempt: true,
    sendTurn,
    conversationSessionStart,
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const pending = chat.host.querySelector('[data-pending-first-message]')
    expect(pending?.textContent, 'the message shows at once, as the bubble it will be').toContain('fix the login')
    expect(pending?.textContent, 'under the line every turn shows').toContain('Thinking…')
    expect(pending?.textContent, 'the setup is not put in front of the person').not.toContain('worktree')
    // Folded under the line, for whoever asks.
    await chat.act(async () =>
      chat.host.querySelector<HTMLButtonElement>('button[aria-label="Show what it is doing"]')!.click(),
    )
    expect(chat.host.querySelector('[data-setup-step="worktree"]')?.textContent).toMatch(/^Worktree on agent\//u)
    expect(conversationSessionStart, 'no session before the folder is set').not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
    expect(chat.agent().chatStartupPrompt, 'the message is held, not spent').toBe('fix the login')

    await chat.act(async () => worktree.settle('ok'))
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const workspace = useWorkspaceStore.getState().workspaces[0]
    expect(workspace.folderPath).toBe(PENDING_WORKTREE)
    expect(workspace.worktree).toMatchObject({ repoRoot: PENDING_PROJECT, baseRef: 'main' })
    expect(chat.agent().chatPendingWorktree).toBeUndefined()
    // The worktree is the root now: its transcript opens, and the message goes.
    await chat.act(async () => {
      chat.emit({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null } })
      chat.emit({ type: 'synchronized', seq: 0 })
    })
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: 'fix the login' })
    expect(conversationSessionStart).toHaveBeenCalled()
    for (const [input] of conversationSessionStart.mock.calls) {
      expect(input.workspaceRoot, 'the agent starts in the worktree, never the project').toBe(PENDING_WORKTREE)
    }
  } finally {
    await chat.unmount()
  }
})

test('a worktree that could not be made says why in the chat and gives the prompt back to the composer', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const conversationSessionStart = sessionStartSpy()
  const worktree = deferredWorktree()
  const chat = await mountPendingChat({
    createGitWorktree: worktree.createGitWorktree,
    startAttempt: true,
    sendTurn,
    conversationSessionStart,
  })
  try {
    await chat.act(async () => worktree.settle({ ok: false, message: 'Could not fetch origin.' }))
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(chat.host.textContent).toContain('The worktree couldn’t be made')
    expect(chat.host.textContent).toContain('Could not fetch origin.')
    expect(chat.draft(), 'the message is back in the composer').toBe('fix the login')
    expect(chat.agent().chatStartupPrompt).toBeUndefined()
    expect(chat.button('Retry')).toBeDefined()
    expect(conversationSessionStart).not.toHaveBeenCalled()

    // Start in the project: the chat runs in the checkout, as asked, and the
    // message waits in the composer for its Enter.
    await chat.act(async () => chat.button('Start in the project')!.click())
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const workspace = useWorkspaceStore.getState().workspaces[0]
    expect(workspace.folderPath).toBe(PENDING_PROJECT)
    expect(workspace.worktree ?? null).toBeNull()
    expect(chat.agent().chatPendingWorktree).toBeUndefined()
    expect(sendTurn).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('a chat waiting on its worktree queues what Enter sends behind its first message', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const conversationSessionStart = sessionStartSpy()
  const worktree = deferredWorktree()
  const chat = await mountPendingChat({
    createGitWorktree: worktree.createGitWorktree,
    startAttempt: true,
    sendTurn,
    conversationSessionStart,
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(chat.field().getAttribute('contenteditable'), 'the composer takes input while it waits').toBe('true')
    await chat.act(async () => chat.type('and the signup page'))
    await chat.act(async () => void chat.enter())
    expect(sendTurn, 'nothing goes before the chat can send').not.toHaveBeenCalled()
    expect(chat.draft(), 'queued, as a reply typed while a turn runs is').toBe('')
    expect(chat.host.textContent).toContain('and the signup page')

    await chat.act(async () => worktree.settle('ok'))
    await chat.act(async () => {
      chat.emit({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null } })
      chat.emit({ type: 'synchronized', seq: 0 })
    })
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sendTurn.mock.calls[0][0], 'the launcher’s message goes first').toMatchObject({
      message: 'fix the login',
    })
    // This mock's turn ends as soon as it is sent: the queued one follows it.
    expect(sendTurn.mock.calls.map(([input]) => input.message)).toEqual(['fix the login', 'and the signup page'])
  } finally {
    await chat.unmount()
  }
})

test('a worktree that failed puts the message back ahead of what was typed while it was being made', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const worktree = deferredWorktree()
  const chat = await mountPendingChat({
    createGitWorktree: worktree.createGitWorktree,
    startAttempt: true,
    sendTurn,
    conversationSessionStart: sessionStartSpy(),
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await chat.act(async () => chat.type('and the signup page'))
    await chat.act(async () => worktree.settle({ ok: false, message: 'Could not fetch origin.' }))
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(chat.draft()).toBe('fix the login\nand the signup page')
    expect(chat.field().getAttribute('contenteditable'), 'the box the message is back in can be edited').toBe('true')
    await chat.act(async () => void chat.enter())
    expect(sendTurn, 'nothing sends from a chat with no folder').not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('a chat still waiting on its worktree when the app went away comes back failed, and Retry makes it again', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const conversationSessionStart = sessionStartSpy()
  const worktree = deferredWorktree()
  // No attempt: the one that was running went with the window.
  const chat = await mountPendingChat({
    createGitWorktree: worktree.createGitWorktree,
    startAttempt: false,
    sendTurn,
    conversationSessionStart,
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(chat.host.textContent, 'not stuck preparing').toContain('The worktree couldn’t be made')
    expect(chat.host.textContent).toContain('Studio closed before this chat’s worktree was made.')
    expect(chat.draft()).toBe('fix the login')
    expect(worktree.createGitWorktree).not.toHaveBeenCalled()

    await chat.act(async () => chat.button('Retry')!.click())
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(worktree.createGitWorktree).toHaveBeenCalledOnce()
    // Its message is the composer's again, so there is no first bubble to work under.
    expect(chat.host.textContent).toContain('Preparing worktree…')
    expect(conversationSessionStart).not.toHaveBeenCalled()
    await chat.act(async () => worktree.settle('ok'))
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    expect(useWorkspaceStore.getState().workspaces[0].folderPath).toBe(PENDING_WORKTREE)
  } finally {
    await chat.unmount()
  }
})

test('a launcher image that is gone leaves the text as the draft, with the reason, and sends nothing', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({
    capabilities: { images: true },
    agent: { chatStartupPrompt: 'It looks wrong', chatStartupImages: [LAUNCH_SHOT] },
    sendTurn,
    api: {
      readImageDataUrl: async () => {
        throw new Error("Error invoking remote method 'fs:read-image-data-url': Error: ENOENT: no such file")
      },
    },
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sendTurn).not.toHaveBeenCalled()
    expect(chat.draft()).toBe('It looks wrong')
    expect(chat.host.textContent).toContain('Could not attach Screenshot 2026-10-04 at 12.15.13.png')
  } finally {
    await chat.unmount()
  }
})

test('the composer offers one engine chip — no plan toggle, no separate permission or effort pill, no dollars', async () => {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'opus',
    capabilities: { approvals: true, permissionPresets: ['bypass', 'none'], reasoningEfforts: ['low', 'high'] },
  })
  try {
    const buttons = () => Array.from(chat.dom.window.document.querySelectorAll('button'))
    const chips = buttons().filter((item) => item.getAttribute('aria-label')?.startsWith('Engine:'))
    expect(chips).toHaveLength(1)
    // The permissions are not a chip of their own on the row any more: they
    // sit on the picker's trailing row, as a launch's do.
    const permissionChip = (item: Element) => item.getAttribute('aria-label')?.startsWith('Permissions:')
    expect(buttons().some(permissionChip)).toBe(false)
    for (const retired of ['Plan', 'Bypass permissions', 'CLI default', 'Auto']) {
      expect(
        buttons().some((item) => !permissionChip(item) && item.textContent?.trim() === retired),
        `no standalone “${retired}” control`,
      ).toBe(false)
    }
    expect(chat.host.textContent).not.toMatch(/\$\d/)
    // The chip opens the terminal agent's picker, locked to this chat's CLI.
    await chat.act(async () => chips[0].click())
    const rail = chat.dom.window.document.querySelector('[role="radiogroup"][aria-label="Provider"]')
    expect(rail?.querySelectorAll('[role="radio"]')).toHaveLength(1)
    expect(chat.dom.window.document.querySelector('[role="listbox"][aria-label="Agent runtime"]')).not.toBeNull()
    // The chat's own permissions, on the picker's trailing row.
    expect(buttons().filter(permissionChip)).toHaveLength(1)
  } finally {
    await chat.unmount()
  }
})

test('a chat named after its model is renamed from the agent-name pool', async () => {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
    providerModels: [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }],
    agent: { name: 'Opus 5.5 2' },
  })
  try {
    await chat.act(async () => undefined)
    const name = chat.agent().name
    expect(name).not.toMatch(/Opus/)
    expect(name?.trim()).toBeTruthy()
  } finally {
    await chat.unmount()
  }
})

test('a chat the person named keeps its name', async () => {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
    providerModels: [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }],
    agent: { name: 'Release checklist' },
  })
  try {
    await chat.act(async () => undefined)
    expect(chat.agent().name).toBe('Release checklist')
  } finally {
    await chat.unmount()
  }
})

test('the first message renders once, as its bubble, with no title row repeating it', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'hello', text: 'Check the build' }),
      event('turn_started', { turnId: 'hello' }),
      event('content_delta', { turnId: 'hello', text: 'It builds.' }),
      event('turn_completed', { turnId: 'hello' }),
    ],
  })
  try {
    expect(chat.host.textContent?.split('Check the build').length).toBe(2)
  } finally {
    await chat.unmount()
  }
})

test('the transcript takes the kit’s focus ring on keyboard focus only', async () => {
  const chat = await mountChat({ events: [event('user_message', { turnId: 'a', text: 'hello' })] })
  try {
    const scroller = chat.host.querySelector('[role="log"] > div')!
    expect(scroller.className).toContain('focus-visible:focus-ring-inset')
    expect(scroller.className).toContain('focus:outline-none')
  } finally {
    await chat.unmount()
  }
})

test('opening a folded turn does not flash the jump-to-latest pill', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'a', text: 'Check the build' }),
      event('turn_started', { turnId: 'a' }),
      event('tool_started', { turnId: 'a', toolUseId: 'one', name: 'Read', input: { path: 'a.ts' } }),
      event('tool_output', { turnId: 'a', toolUseId: 'one', output: 'a', status: 'ok' }),
      event('tool_started', { turnId: 'a', toolUseId: 'two', name: 'Read', input: { path: 'b.ts' } }),
      event('tool_output', { turnId: 'a', toolUseId: 'two', output: 'b', status: 'ok' }),
      event('content_delta', { turnId: 'a', text: 'It builds.' }),
      event('turn_completed', { turnId: 'a' }),
    ],
  })
  try {
    const fold = chat.button('Worked for')
    expect(fold).toBeDefined()
    expect(chat.host.textContent).not.toContain('Jump to latest')
    await chat.act(async () => fold!.click())
    expect(chat.host.textContent).not.toContain('Jump to latest')
  } finally {
    await chat.unmount()
  }
})

// A reply event at a set time: the divider is placed by when replies began
// and finished against the chat's visit clock.
function eventAt(createdAt: number, type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  return { ...event(type, payload), createdAt }
}

test('a chat opened with replies nobody has read opens at a New divider, which holds until the chat is left', async () => {
  const { noteChatOpened, noteChatLeft } = await import('./unreadDivider')
  // Read up to the first reply; the second, which worked through two folded
  // steps, finished after the last visit.
  noteChatOpened('workspace', 2_500, 10_000)
  scrolledToIndex.length = 0
  mountedAt.length = 0
  const chat = await mountChat({
    events: [
      eventAt(1_000, 'user_message', { turnId: 'a', text: 'Check the build' }),
      eventAt(1_100, 'turn_started', { turnId: 'a' }),
      eventAt(1_200, 'content_delta', { turnId: 'a', text: 'It builds.' }),
      eventAt(2_000, 'turn_completed', { turnId: 'a' }),
      eventAt(3_000, 'user_message', { turnId: 'b', text: 'Now the tests' }),
      eventAt(3_100, 'turn_started', { turnId: 'b' }),
      eventAt(3_200, 'tool_started', { turnId: 'b', toolUseId: 'one', name: 'Read', input: { path: 'a.ts' } }),
      eventAt(3_300, 'tool_output', { turnId: 'b', toolUseId: 'one', output: 'a', status: 'ok' }),
      eventAt(3_400, 'tool_started', { turnId: 'b', toolUseId: 'two', name: 'Read', input: { path: 'b.ts' } }),
      eventAt(3_500, 'tool_output', { turnId: 'b', toolUseId: 'two', output: 'b', status: 'ok' }),
      eventAt(3_600, 'content_delta', { turnId: 'b', text: 'They pass.' }),
      eventAt(4_000, 'turn_completed', { turnId: 'b' }),
    ],
  })
  const dividers = () =>
    Array.from(chat.host.querySelectorAll('[role="separator"][aria-label="New since you last looked"]'))
  // The row the divider stands above, by what it says.
  const belowDivider = () => {
    const [divider] = dividers()
    return divider?.nextElementSibling?.textContent ?? null
  }
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(dividers()).toHaveLength(1)
    expect(belowDivider(), 'above the unread reply, steps and all, not inside its work').toContain('They pass.')
    expect(belowDivider()).not.toContain('Now the tests')
    expect(mountedAt.at(-1), 'the list starts at the divider, not at the end and a frame later there').toEqual({
      initialScrollIndex: 3,
      initialScrollAtEnd: false,
    })

    // The agent goes on: a new turn streams in while the chat is in front.
    await chat.act(async () => {
      chat.emit({ type: 'event', event: eventAt(11_000, 'user_message', { turnId: 'c', text: 'And lint' }) })
      chat.emit({ type: 'event', event: eventAt(11_100, 'turn_started', { turnId: 'c' }) })
      chat.emit({ type: 'event', event: eventAt(11_200, 'content_delta', { turnId: 'c', text: 'Lint is clean.' }) })
    })
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(dividers(), 'one divider, where it was').toHaveLength(1)
    expect(belowDivider()).toContain('They pass.')
    expect(
      scrolledToIndex.filter((target) => target.index === 3),
      'landed once per opening',
    ).toHaveLength(1)

    await chat.act(async () => noteChatLeft('workspace'))
    expect(dividers(), 'gone once the chat is left').toHaveLength(0)
    // Back again with everything seen: nothing new, no divider.
    await chat.act(async () => noteChatOpened('workspace', 12_000, 13_000))
    expect(dividers()).toHaveLength(0)
    await chat.act(async () => noteChatLeft('workspace'))

    // The last turn ends out of sight, and the chat is marked unread
    // (`conversation.mark_unread`): its visit clock goes back to just before
    // that finish, and the next opening puts the divider above that reply.
    await chat.act(async () => {
      chat.emit({ type: 'event', event: eventAt(13_500, 'turn_completed', { turnId: 'c' }) })
    })
    await chat.act(async () => noteChatOpened('workspace', 13_499, 15_000))
    expect(dividers()).toHaveLength(1)
    expect(belowDivider()).toContain('Lint is clean.')
  } finally {
    noteChatLeft('workspace')
    await chat.unmount()
  }
})

test('a chat left mid-history still opens at its New divider, not at the place it was left', async () => {
  const { noteChatOpened, noteChatLeft } = await import('./unreadDivider')
  const { rememberConversationScroll } = await import('./conversationViewState')
  const events = [
    eventAt(1_000, 'user_message', { turnId: 'a', text: 'Check the build' }),
    eventAt(1_100, 'turn_started', { turnId: 'a' }),
    eventAt(1_200, 'content_delta', { turnId: 'a', text: 'It builds.' }),
    eventAt(2_000, 'turn_completed', { turnId: 'a' }),
    eventAt(3_000, 'user_message', { turnId: 'b', text: 'Now the tests' }),
    eventAt(3_100, 'turn_started', { turnId: 'b' }),
    eventAt(3_600, 'content_delta', { turnId: 'b', text: 'They pass.' }),
    eventAt(4_000, 'turn_completed', { turnId: 'b' }),
  ]
  // Left reading the first message, above everything new.
  const first = await mountChat({ events })
  const [firstRow] = listedKeys.current
  await first.unmount()
  expect(firstRow).toBeDefined()
  rememberConversationScroll('workspace:agent', { atEnd: false, rowId: firstRow!, offset: 0 })
  noteChatOpened('workspace', 2_500, 10_000)
  scrolledToIndex.length = 0
  mountedAt.length = 0
  const chat = await mountChat({ events })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    const divider = listedKeys.current.indexOf('assistant:b')
    expect(divider).toBeGreaterThan(0)
    expect(mountedAt.at(-1), 'the divider, not the remembered place').toEqual({
      initialScrollIndex: divider,
      initialScrollAtEnd: false,
    })
    expect(
      scrolledToIndex.some((target) => target.index === 0),
      'the remembered place is not restored over it',
    ).toBe(false)
  } finally {
    noteChatLeft('workspace')
    await chat.unmount()
  }
})

test('a chat already loaded opens at its New divider on its first frame when it is made active', async () => {
  const { noteChatLeft } = await import('./unreadDivider')
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const events = [
    eventAt(1_000, 'user_message', { turnId: 'a', text: 'Check the build' }),
    eventAt(1_100, 'turn_started', { turnId: 'a' }),
    eventAt(1_200, 'content_delta', { turnId: 'a', text: 'It builds.' }),
    eventAt(2_000, 'turn_completed', { turnId: 'a' }),
    eventAt(3_000, 'user_message', { turnId: 'b', text: 'Now the tests' }),
    eventAt(3_100, 'turn_started', { turnId: 'b' }),
    eventAt(3_600, 'content_delta', { turnId: 'b', text: 'They pass.' }),
    eventAt(4_000, 'turn_completed', { turnId: 'b' }),
  ]
  // Read once and left: the window keeps its transcript, so the next time it
  // is drawn it is drawn whole, at once, with no load to wait for. A folder of
  // its own, so no other test is handed this transcript.
  const folderPath = '/Users/dev/kept'
  const first = await mountChat({ events, folderPath })
  await first.act(async () =>
    first.emit({ type: 'synchronized', seq: events.at(-1)!.seq!, generation: 'kept' } as ConversationSessionFrame),
  )
  await first.unmount()
  scrolledToIndex.length = 0
  mountedAt.length = 0
  // The window is up first, showing another chat; this one is opened after,
  // by the click that makes it active.
  const chat = await mountChat({ events, whenActive: true, folderPath })
  try {
    expect(mountedAt, 'not drawn while another chat is in front').toEqual([])
    useWorkspaceStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => ({ ...workspace, lastVisitedAt: 2_500 })),
    }))
    await chat.act(async () => useWorkspaceStore.getState().setActiveWorkspace('workspace'))
    const divider = listedKeys.current.indexOf('assistant:b')
    expect(divider).toBeGreaterThan(0)
    expect(mountedAt[0], 'its list starts at the divider, not at the end and a frame later there').toEqual({
      initialScrollIndex: divider,
      initialScrollAtEnd: false,
    })
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(
      scrolledToIndex.every((target) => target.index === divider),
      'nothing takes it anywhere else first',
    ).toBe(true)
  } finally {
    noteChatLeft('workspace')
    await chat.unmount()
  }
})

test('a kept chat whose unseen reply comes in its catch-up still opens at the New divider', async () => {
  const { noteChatLeft } = await import('./unreadDivider')
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const before = [
    eventAt(1_000, 'user_message', { turnId: 'a', text: 'Check the build' }),
    eventAt(1_100, 'turn_started', { turnId: 'a' }),
    eventAt(1_200, 'content_delta', { turnId: 'a', text: 'It builds.' }),
    eventAt(2_000, 'turn_completed', { turnId: 'a' }),
    eventAt(3_000, 'user_message', { turnId: 'b', text: 'Now the tests' }),
  ]
  // Read and left while the agent was still at it: the window keeps what it
  // had then.
  const folderPath = '/Users/dev/kept-catch-up'
  const first = await mountChat({ events: before, folderPath })
  await first.act(async () =>
    first.emit({ type: 'synchronized', seq: before.at(-1)!.seq!, generation: 'kept' } as ConversationSessionFrame),
  )
  await first.unmount()
  // While it is closed, the agent answers.
  const after = [
    eventAt(3_100, 'turn_started', { turnId: 'b' }),
    eventAt(3_600, 'content_delta', { turnId: 'b', text: 'They pass.' }),
    eventAt(4_000, 'turn_completed', { turnId: 'b' }),
  ]
  scrolledToIndex.length = 0
  mountedAt.length = 0
  const chat = await mountChat({ events: [], whenActive: true, folderPath })
  try {
    useWorkspaceStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => ({ ...workspace, lastVisitedAt: 2_500 })),
    }))
    await chat.act(async () => useWorkspaceStore.getState().setActiveWorkspace('workspace'))
    expect(listedKeys.current.indexOf('assistant:b'), 'the held transcript has no reply to b yet').toBe(-1)
    // The catch-up behind this join's fence.
    await chat.act(async () => {
      for (const next of after) chat.emit({ type: 'event', event: next })
      chat.emit({ type: 'synchronized', seq: after.at(-1)!.seq!, generation: 'kept' } as ConversationSessionFrame)
    })
    for (let turn = 0; turn < 50 && !scrolledToIndex.length; turn++)
      await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    const divider = listedKeys.current.indexOf('assistant:b')
    expect(divider).toBeGreaterThan(0)
    expect(chat.host.innerHTML).toContain('New since you last looked')
    expect(scrolledToIndex.at(-1), 'it lands at the divider').toEqual({ index: divider, viewPosition: 0 })
  } finally {
    noteChatLeft('workspace')
    await chat.unmount()
  }
})

test('a turn never shows a dollar figure, even when the provider reports one', async () => {
  const events = [
    event('user_message', { turnId: 'priced', text: 'Summarize' }),
    event('turn_started', { turnId: 'priced' }),
    event('content_delta', { turnId: 'priced', text: 'Done.' }),
    event('turn_completed', { turnId: 'priced', costUsd: 0.0123, durationMs: 1200 }),
  ]
  const chat = await mountChat({ events, capabilities: { cost: true } })
  try {
    expect(chat.host.textContent).not.toContain('$')
    // The elapsed time and the copy glyph stay under the reply.
    expect(chat.host.querySelector('button[aria-label="Copy reply"]')).not.toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('a started chat switches models within its CLI from the full catalog, applied through the live session', async () => {
  const setModel = vi.fn(async (input: { sessionId: string; modelId: string }) => ({
    ok: true,
    session: {
      sessionId: input.sessionId,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'claude-agent',
      modelId: input.modelId,
      status: 'ready',
      createdAt: 1,
      updatedAt: 2,
      capabilities: { liveModelSwitch: true },
    },
    notice: 'The new model starts with your next message.',
  }))
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
    capabilities: { liveModelSwitch: true },
    sendTurn: async () => ({ ok: true }),
    setModel,
    plugins: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        source: 'bundled',
        version: 1,
        binary: 'claude',
        modelSelection: {
          args: ['--model', '{{model}}'],
          options: [
            { id: 'claude-opus-5-5', label: 'Opus 5.5' },
            { id: 'claude-fable-5-1', label: 'Fable 5.1' },
          ],
        },
      },
    ],
  })
  try {
    // A first turn starts the live session.
    await chat.act(async () => chat.type('hello'))
    await chat.act(async () => chat.enter())
    const doc = chat.dom.window.document
    const chip = () =>
      Array.from(doc.querySelectorAll('button')).find((item) => item.getAttribute('aria-label')?.startsWith('Engine:'))!
    expect(chip().getAttribute('aria-label')).toBe('Engine: Opus 5.5')
    await chat.act(async () => chip().click())
    const rows = Array.from(doc.querySelectorAll('[role="listbox"][aria-label="Agent runtime"] [role="option"]'))
    const names = rows.map((row) => row.textContent ?? '')
    expect(
      names.some((name) => name.includes('Fable 5.1')),
      'the full catalog, not only the current model',
    ).toBe(true)
    expect(doc.body.textContent).not.toContain('model is set once the chat starts')
    const fable = rows.find((row) => row.textContent?.includes('Fable 5.1')) as HTMLElement
    await chat.act(async () => fable.click())
    expect(setModel).toHaveBeenCalledWith({ sessionId: 'session', modelId: 'claude-fable-5-1' })
    expect(chat.agent().conversation?.modelId).toBe('claude-fable-5-1')
    expect(chip().getAttribute('aria-label')).toBe('Engine: Fable 5.1')
    expect(chat.host.textContent).toContain('The new model starts with your next message.')
  } finally {
    await chat.unmount()
  }
})

test("a switch made from a paired device moves this chat's record, while one replayed from history does not", async () => {
  const replayed = event('session_updated', { modelId: 'replayed-model' })
  const chat = await mountChat({
    events: [event('user_message', { turnId: 't', text: 'hello' }), replayed],
    capabilities: { liveModelSwitch: true },
  })
  try {
    // History is history: the record may have moved since that switch.
    expect(chat.agent().conversation?.modelId).toBe('mock-model')
    await chat.act(async () =>
      chat.emit({ type: 'event', event: event('session_updated', { modelId: 'remote-model' }) }),
    )
    expect(chat.agent().conversation).toEqual({ providerId: 'mock', modelId: 'remote-model' })
    // An event that names no model (a notice, a native session id) leaves it.
    await chat.act(async () => chat.emit({ type: 'event', event: event('session_updated', { notice: 'Resumed.' }) }))
    expect(chat.agent().conversation?.modelId).toBe('remote-model')
  } finally {
    await chat.unmount()
  }
})

// A running turn the test holds open: its send settles only when released,
// the way a local send does once the whole turn has streamed.
function runningTurnSend() {
  const calls: Array<Record<string, unknown>> = []
  let release = () => undefined as void
  const sendTurn = vi.fn<SendTurn>(async (input) => {
    calls.push(input as Record<string, unknown>)
    if ((input as { steer?: boolean }).steer) return { ok: true }
    await new Promise<void>((resolve) => (release = resolve))
    return { ok: true }
  })
  return { sendTurn, calls, release: () => release() }
}

test('a queued message is a row of the composer tray, not a bubble over the transcript', async () => {
  const turn = runningTurnSend()
  // An agent that cannot take a message mid-turn: what is sent while it works waits.
  const chat = await mountChat({ sendTurn: turn.sendTurn })
  try {
    await chat.act(async () => chat.type('Investigate the flaky test'))
    await chat.act(async () => chat.enter())
    const localTurnId = turn.calls[0]?.localTurnId
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 't1', text: 'x', localTurnId }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
    })
    await chat.act(async () => chat.type('Use the staging config'))
    await chat.act(async () => chat.enter())
    const row = chat.host.querySelector<HTMLElement>('[aria-label="Queued message"]')!
    expect(row.closest('[data-composer-tray]'), 'in the tray above the composer').not.toBeNull()
    expect(row.closest('[role="log"]'), 'not over the transcript').toBeNull()
    expect(row.textContent).toContain('Queued')
    expect(row.textContent).toContain('Use the staging config')
    expect(turn.sendTurn).toHaveBeenCalledOnce()
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('a message sent while the turn runs waits in the queue until Send now hands it to the turn', async () => {
  const turn = runningTurnSend()
  // Even an agent that takes messages mid-turn gets one only when the person
  // asks: a message the turn never took in must still be there to see.
  const chat = await mountChat({ capabilities: { steer: true }, sendTurn: turn.sendTurn })
  try {
    await chat.act(async () => chat.type('Investigate the flaky test'))
    await chat.act(async () => chat.enter())
    const localTurnId = turn.calls[0]?.localTurnId
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 't1', text: 'x', localTurnId }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
    })
    await chat.act(async () => chat.type('Use the staging config'))
    await chat.act(async () => chat.enter())
    expect(turn.sendTurn).toHaveBeenCalledOnce()
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('Use the staging config')
    await chat.act(async () => chat.button('Send now')!.click())
    expect(turn.calls[1]).toMatchObject({ message: 'Use the staging config', steer: true })
    expect(chat.host.querySelector('[aria-label="Queued message"]')).toBeNull()
    // The steered message is a bubble in the transcript straight away.
    expect(chat.host.textContent).toContain('Use the staging config')
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('⌘↵ mid-turn sends the draft now; a provider without steering stops the turn instead', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn })
  // The stand-in API has no Stop; this case needs one.
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  try {
    await chat.act(async () => chat.type('Investigate the flaky test'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't2' }) })
    })
    await chat.act(async () => chat.type('Stop, wrong branch'))
    expect(chat.host.textContent).not.toContain('Stop and send')
    await chat.act(async () => {
      chat.field().dispatchEvent(
        new chat.dom.window.KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(interrupt).toHaveBeenCalledOnce()
    expect(turn.sendTurn, 'the draft waits in the queue for the stopped turn').toHaveBeenCalledOnce()
    expect(chat.button('Stop and send')).toBeDefined()
    expect(chat.draft()).toBe('')
  } finally {
    turn.release()
    await chat.unmount()
  }
})

// Starts a turn and queues a second message while it runs, the way the cases
// below all begin.
async function sendBehindRunningTurn(chat: Awaited<ReturnType<typeof mountChat>>, calls: Record<string, unknown>[]) {
  await chat.act(async () => chat.type('Investigate the flaky test'))
  await chat.act(async () => chat.enter())
  await chat.act(async () => {
    chat.emit({
      type: 'event',
      event: event('user_message', { turnId: 't1', text: 'x', localTurnId: calls[0]?.localTurnId }),
    })
    chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
  })
  await chat.act(async () => chat.type('Use the staging config'))
  await chat.act(async () => chat.enter())
}

// Hands the queued message to the running turn, as "Send now" does.
async function steerQueued(chat: Awaited<ReturnType<typeof mountChat>>) {
  await chat.act(async () => chat.button('Send now')!.click())
}

test('a steer that fails after its message landed reports the failure and is not sent a second time', async () => {
  const calls: Array<Record<string, unknown>> = []
  let failSteer = () => undefined as void
  const sendTurn = vi.fn<SendTurn>(async (input) => {
    calls.push(input as Record<string, unknown>)
    if ((input as { steer?: boolean }).steer) {
      await new Promise<void>((resolve) => (failSteer = resolve))
      return { ok: false, message: 'The agent stopped unexpectedly.' }
    }
    return { ok: true }
  })
  const chat = await mountChat({ capabilities: { steer: true }, sendTurn })
  try {
    await sendBehindRunningTurn(chat, calls)
    await steerQueued(chat)
    expect(calls[1]).toMatchObject({ message: 'Use the staging config', steer: true })
    await chat.act(async () => {
      chat.emit({
        type: 'event',
        event: event('user_message', {
          turnId: 't2',
          text: 'Use the staging config',
          localTurnId: calls[1].localTurnId,
        }),
      })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't2' }) })
    })
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_failed', { turnId: 't2', reason: 'runtime' }) })
      failSteer()
    })
    expect(sendTurn, 'the message is already in the conversation').toHaveBeenCalledTimes(2)
    expect(chat.host.querySelector('[aria-label="Queued message"]')).toBeNull()
    expect(chat.host.textContent).toContain('The agent stopped unexpectedly.')
  } finally {
    await chat.unmount()
  }
})

test('a message sent while a steer is still going in queues, and stays queued once it lands', async () => {
  const calls: Array<Record<string, unknown>> = []
  const sendTurn = vi.fn<SendTurn>(async (input) => {
    calls.push(input as Record<string, unknown>)
    await new Promise<void>(() => undefined)
    return { ok: true }
  })
  const chat = await mountChat({ capabilities: { steer: true }, sendTurn })
  try {
    await sendBehindRunningTurn(chat, calls)
    await steerQueued(chat)
    expect(calls[1]).toMatchObject({ message: 'Use the staging config', steer: true })
    await chat.act(async () => chat.type('And the prod one'))
    await chat.act(async () => chat.enter())
    expect(sendTurn).toHaveBeenCalledTimes(2)
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('And the prod one')
    await chat.act(async () => {
      chat.emit({
        type: 'event',
        event: event('user_message', {
          turnId: 't2',
          text: 'Use the staging config',
          localTurnId: calls[1].localTurnId,
        }),
      })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't2' }) })
    })
    // It goes when the turn ends, or when the person says so — not by itself.
    expect(sendTurn).toHaveBeenCalledTimes(2)
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('And the prod one')
    await steerQueued(chat)
    expect(calls[2]).toMatchObject({ message: 'And the prod one', steer: true })
    expect(chat.host.querySelector('[aria-label="Queued message"]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('a steer refused before its message landed goes back to the queue', async () => {
  const turn = runningTurnSend()
  const sendTurn = vi.fn<SendTurn>(async (input) =>
    (input as { steer?: boolean }).steer
      ? { ok: false, message: 'This agent cannot take a message while it is working.' }
      : turn.sendTurn(input),
  )
  const chat = await mountChat({ capabilities: { steer: true }, sendTurn })
  try {
    await sendBehindRunningTurn(chat, turn.calls)
    await steerQueued(chat)
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('Use the staging config')
    expect(chat.host.textContent).toContain('This agent cannot take a message while it is working.')
    expect(sendTurn, 'a refused steer is not handed straight back').toHaveBeenCalledTimes(2)
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('Stop and send keeps the queued message until the stopped send settles, then sends it', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  try {
    await sendBehindRunningTurn(chat, turn.calls)
    await chat.act(async () => chat.button('Stop and send')!.click())
    expect(interrupt).toHaveBeenCalledOnce()
    // The turn ends on screen before the send that started it has settled.
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_failed', { turnId: 't1', reason: 'interrupted' }) })
    })
    expect(turn.sendTurn).toHaveBeenCalledOnce()
    expect(chat.host.querySelector('[aria-label="Queued message"]')?.textContent).toContain('Use the staging config')
    await chat.act(async () => turn.release())
    expect(turn.sendTurn).toHaveBeenCalledTimes(2)
    expect(turn.calls[1]).toMatchObject({ message: 'Use the staging config' })
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('the drop overlay leaves with the drag, however many rows it crossed or lost on the way', async () => {
  const chat = await mountChat({ capabilities: { images: true } })
  const doc = chat.dom.window.document
  const drag = (type: string, target: EventTarget, relatedTarget: EventTarget | null = null) => {
    const dragEvent = new chat.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget })
    Object.defineProperty(dragEvent, 'dataTransfer', { value: { types: ['Files'], items: [], files: [] } })
    target.dispatchEvent(dragEvent)
  }
  const overlay = () => chat.host.textContent?.includes('Drop to attach')
  try {
    const composer = chat.field()
    const inside = chat.host.querySelector('button')!
    // Two enters, as crossing a row and then the composer reports them, and
    // only one leave: the row was removed before it could report its own.
    await chat.act(async () => {
      drag('dragenter', inside)
      drag('dragenter', composer)
    })
    expect(overlay()).toBe(true)
    const drop = [...chat.host.querySelectorAll('div')].find((element) => element.textContent === 'Drop to attach')
    expect(drop?.className, 'it floats on the layer for a tray over its pane').toContain('z-[var(--z-float)]')
    await chat.act(async () => drag('dragleave', composer, inside))
    expect(overlay(), 'moving within the panel keeps it').toBe(true)
    await chat.act(async () => drag('dragleave', composer, doc.body))
    expect(overlay(), 'leaving the panel clears it').toBe(false)

    await chat.act(async () => drag('dragenter', composer))
    expect(overlay()).toBe(true)
    await chat.act(async () => {
      chat.dom.window.dispatchEvent(new chat.dom.window.Event('dragend'))
    })
    expect(overlay(), 'a drag that ends anywhere clears it').toBe(false)
  } finally {
    await chat.unmount()
  }
})

// A drop's payload as the chat reads it: OS files with the paths Electron
// reports, or the studio's own file drag from the Files pane.
function dropTransfer(
  window: Window,
  source: { files: { name: string; type: string; path: string }[] } | { studioPaths: string[] },
) {
  if ('studioPaths' in source) {
    const payload = JSON.stringify({
      version: 1,
      workspaceId: 'workspace',
      rootPath: '/Users/dev/project',
      files: source.studioPaths.map((path) => ({ path, name: path.split('/').at(-1) })),
    })
    return {
      types: ['application/x-sprintengine-file-drop', 'text/plain'],
      items: [],
      files: [],
      getData: (type: string) => (type === 'application/x-sprintengine-file-drop' ? payload : ''),
    }
  }
  const files = source.files.map((file) => new File(['x'], file.name, { type: file.type }))
  const paths = new Map(files.map((file, index) => [file, source.files[index].path]))
  const api = (window as unknown as { api: Record<string, unknown> }).api
  api.getPathForFile = (file: File) => paths.get(file) ?? ''
  api.attachFile = (file: File) => paths.get(file) ?? ''
  return {
    types: ['Files'],
    items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    files,
    getData: () => '',
  }
}

function dropOn(chat: Awaited<ReturnType<typeof mountChat>>, target: EventTarget, dataTransfer: unknown) {
  const drop = new chat.dom.window.MouseEvent('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
  target.dispatchEvent(drop)
  return drop
}

test('any file dropped from the OS is attached as its card, and goes to the agent beside the words, not in them', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Summarise'))
    const transcript = chat.host.querySelector('button')!
    const drop = dropTransfer(chat.dom.window as unknown as Window, {
      files: [
        { name: 'Q3 budget.xlsx', type: 'application/vnd.ms-excel', path: '/Users/dev/Desktop/Q3 budget.xlsx' },
        { name: 'shot.png', type: 'image/png', path: '/Users/dev/Desktop/shot.png' },
      ],
    })
    let event: Event | undefined
    await chat.act(async () => {
      event = dropOn(chat, transcript, drop)
    })
    expect(event!.defaultPrevented, 'the drop is claimed, not handed to the window').toBe(true)
    expect(chat.draft(), 'the words are left as they were typed').toBe('Summarise')
    const cards = () => Array.from(chat.host.querySelectorAll('button[aria-label^="Open "]'))
    expect(cards().map((card) => card.getAttribute('aria-label'))).toEqual(['Open Q3 budget.xlsx', 'Open shot.png'])
    expect(cards()[0].textContent).toContain('XLSX')
    expect(chat.host.textContent).not.toContain('can be attached')
    // Removing a card takes its file out of the message.
    const keep = dropTransfer(chat.dom.window as unknown as Window, {
      files: [{ name: 'notes.pdf', type: 'application/pdf', path: '/Users/dev/Desktop/notes.pdf' }],
    })
    await chat.act(async () => {
      dropOn(chat, transcript, keep)
    })
    await chat.act(async () => {
      ;(chat.host.querySelector('button[aria-label="Remove notes.pdf"]') as HTMLElement).click()
    })
    expect(cards()).toHaveLength(2)
    await chat.act(async () => chat.enter())
    expect(sendTurn.mock.calls[0][0]).toMatchObject({
      message: 'Summarise',
      files: [{ path: '/Users/dev/Desktop/Q3 budget.xlsx' }, { path: '/Users/dev/Desktop/shot.png' }],
    })
    expect(
      chat.host.querySelectorAll('button[aria-label^="Remove "]'),
      'the composer lets the cards go with the message',
    ).toHaveLength(0)
    // The sent bubble draws the message's files as the same cards, and its words as they were typed.
    expect(cards().map((card) => card.getAttribute('aria-label'))).toEqual(['Open Q3 budget.xlsx', 'Open shot.png'])
    expect(chat.host.textContent).not.toContain('/Users/dev/Desktop')
  } finally {
    await chat.unmount()
  }
})

test('files dragged out of the Files pane are typed as their paths', async () => {
  const chat = await mountChat({ capabilities: { images: true } })
  try {
    const composer = chat.field()
    const drop = dropTransfer(chat.dom.window as unknown as Window, {
      studioPaths: ['/Users/dev/project/src/app.ts', '/Users/dev/project/docs/logo.png'],
    })
    const over = new chat.dom.window.MouseEvent('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: { ...drop, dropEffect: 'none' } })
    await chat.act(async () => {
      composer.dispatchEvent(over)
    })
    expect(over.defaultPrevented, 'the drag is accepted, so the cursor does not refuse it').toBe(true)
    let event: Event | undefined
    await chat.act(async () => {
      event = dropOn(chat, composer, drop)
    })
    expect(event!.defaultPrevented, "the field's own text drop does not type the paths twice").toBe(true)
    expect(chat.draft()).toBe('/Users/dev/project/src/app.ts /Users/dev/project/docs/logo.png ')
  } finally {
    await chat.unmount()
  }
})

test('a pasted path to an image in the workspace is typed, not attached', async () => {
  const chat = await mountChat({ capabilities: { images: true } })
  const readImageDataUrl = vi.fn(async () => 'data:image/png;base64,iVBORw0K')
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = readImageDataUrl
  try {
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => '/Users/dev/project/public/logo.png' },
    })
    await chat.act(async () => {
      chat.field().dispatchEvent(paste)
    })
    expect(chat.draft(), 'the agent can open it itself').toBe('/Users/dev/project/public/logo.png')
    expect(readImageDataUrl).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('a pasted image path that can no longer be read goes in as text, with the reason', async () => {
  const chat = await mountChat({ capabilities: { images: true } })
  const readImageDataUrl = vi.fn(async () => {
    throw new Error("Error invoking remote method 'fs:read-image-data-url': Error: ENOENT: no such file")
  })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = readImageDataUrl
  try {
    const pasted = "'/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png'"
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => pasted },
    })
    await chat.act(async () => {
      chat.field().dispatchEvent(paste)
    })
    expect(paste.defaultPrevented, 'the path is read rather than typed').toBe(true)
    expect(readImageDataUrl).toHaveBeenCalledWith(
      '/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png',
    )
    expect(chat.draft()).toBe(pasted)
    expect(chat.host.textContent).toContain(
      'Could not attach Screenshot 2026-09-27 at 22.41.31.png: the file no longer exists.',
    )
  } finally {
    await chat.unmount()
  }
})

test('a send that fails offers Retry, which sends that message again and empties the composer', async () => {
  const sendTurn = vi
    .fn<SendTurn>()
    .mockResolvedValueOnce({ ok: false, message: 'The provider is restarting.' })
    .mockResolvedValueOnce({ ok: true })
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Rerun the migration'))
    await chat.act(async () => chat.enter())
    expect(chat.host.textContent).toContain('The provider is restarting.')
    expect(chat.draft(), 'the message is handed back').toBe('Rerun the migration')
    await chat.act(async () => chat.button('Retry')!.click())
    expect(sendTurn).toHaveBeenCalledTimes(2)
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ message: 'Rerun the migration' })
    expect(chat.draft()).toBe('')
    expect(chat.button('Retry')).toBeUndefined()
  } finally {
    await chat.unmount()
  }
})

test('a failed send is a row of the composer tray, and × puts it away', async () => {
  const sendTurn = vi.fn<SendTurn>().mockResolvedValue({ ok: false, message: 'The provider is restarting.' })
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Rerun the migration'))
    await chat.act(async () => chat.enter())
    const alert = chat.host.querySelector<HTMLElement>('[data-composer-tray] [role="alert"]')!
    expect(alert.textContent).toContain('The provider is restarting.')
    expect(chat.button('Retry')).toBeDefined()
    await chat.act(async () => alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
    expect(chat.host.textContent).not.toContain('The provider is restarting.')
    expect(chat.button('Retry')).toBeUndefined()
    // The next failure is news again.
    await chat.act(async () => chat.enter())
    expect(chat.host.textContent).toContain('The provider is restarting.')
  } finally {
    await chat.unmount()
  }
})

test('a context window past 90% says so in the composer tray until it is put away', async () => {
  const chat = await mountChat({
    providerModels: [{ id: 'mock-model', contextLength: 200_000 }],
    events: [
      event('user_message', { turnId: 'a', text: 'Earlier message' }),
      event('usage_updated', { inputTokens: 184_000, outputTokens: 0 }),
    ],
  })
  try {
    const tray = () => chat.host.querySelector<HTMLElement>('[data-composer-tray]')
    expect(tray()?.textContent).toContain('Context 92% full · 184k of 200k tokens')
    // A model provider runs no /compact, so none is offered.
    expect(chat.button('Compact')).toBeUndefined()
    await chat.act(async () => chat.button('Not now')!.click())
    expect(tray()?.textContent ?? '').not.toContain('Context 92% full')
  } finally {
    await chat.unmount()
  }
})

test('Retry sends the failed message as it was, even after the composer was edited', async () => {
  const sendTurn = vi
    .fn<SendTurn>()
    .mockResolvedValueOnce({ ok: false, message: 'The provider is restarting.' })
    .mockResolvedValueOnce({ ok: true })
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Rerun the migration'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => chat.type('Something else entirely'))
    await chat.act(async () => chat.button('Retry')!.click())
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ message: 'Rerun the migration' })
    expect(chat.draft()).toBe('Something else entirely')
  } finally {
    await chat.unmount()
  }
})

test('a Retry refused again leaves the edited draft as it is, with the message still on Retry', async () => {
  const sendTurn = vi.fn<SendTurn>().mockResolvedValue({ ok: false, message: 'The provider is restarting.' })
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Rerun the migration'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => chat.type('Something else entirely'))
    await chat.act(async () => chat.button('Retry')!.click())
    expect(sendTurn).toHaveBeenCalledTimes(2)
    // Only a queued message the person let go of goes back ahead of a draft.
    expect(chat.draft()).toBe('Something else entirely')
    expect(chat.button('Retry')).toBeDefined()
  } finally {
    await chat.unmount()
  }
})

test('Retry after an edit takes the failed send’s images with it, so the next send does not upload them again', async () => {
  const sendTurn = vi
    .fn<SendTurn>()
    .mockResolvedValueOnce({ ok: false, message: 'The provider is restarting.' })
    .mockResolvedValue({ ok: true })
  const chat = await mountChat({ capabilities: { images: true }, sendTurn })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = async () =>
    'data:image/png;base64,iVBORw0KGgo='
  const attached = () => chat.host.querySelector('[aria-label="Remove shot.png"]')
  try {
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => '/Users/dev/Desktop/shot.png' },
    })
    await chat.act(async () => {
      chat.field().dispatchEvent(paste)
    })
    expect(attached(), 'the pasted image is on the composer').not.toBeNull()
    await chat.act(async () => chat.type('What is wrong in this screenshot?'))
    await chat.act(async () => chat.enter())
    expect(attached(), 'a failed send hands its image back').not.toBeNull()
    await chat.act(async () => chat.type('Something else entirely'))
    await chat.act(async () => chat.button('Retry')!.click())
    expect(sendTurn.mock.calls[1][0]).toMatchObject({ message: 'What is wrong in this screenshot?' })
    expect(chat.draft()).toBe('Something else entirely')
    expect(attached(), 'the retry took the image').toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('an error that is not a failed send has no Retry', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({
    capabilities: { images: true },
    sendTurn,
    events: [event('user_message', { turnId: 'a', text: 'Earlier message' })],
  })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.readImageDataUrl = async () => {
    throw new Error('ENOENT: no such file')
  }
  try {
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => '/tmp/gone/Screenshot.png' },
    })
    await chat.act(async () => {
      chat.field().dispatchEvent(paste)
    })
    expect(chat.host.textContent).toContain('Could not attach Screenshot.png')
    expect(chat.button('Retry'), 'nothing to send again').toBeUndefined()
    expect(sendTurn).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('Esc in the composer stops a running turn, and does nothing while the chat is idle', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  const escape = () =>
    chat
      .field()
      .dispatchEvent(new chat.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  try {
    await chat.act(async () => escape())
    expect(interrupt, 'no turn to stop').not.toHaveBeenCalled()
    await chat.act(async () => chat.type('Investigate the flaky test'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
    })
    await chat.act(async () => escape())
    expect(interrupt).toHaveBeenCalledOnce()
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('Esc in the composer leaves a turn that is waiting on a request alone', async () => {
  const turn = runningTurnSend()
  const interrupt = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn: turn.sendTurn, capabilities: { approvals: true } })
  ;(chat.dom.window as unknown as { api: Record<string, unknown> }).api.conversationSessionInterrupt = interrupt
  try {
    await chat.act(async () => chat.type('Run the tests'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 't1' }) })
      chat.emit({
        type: 'event',
        event: event('approval_requested', {
          turnId: 't1',
          requestId: 'approval-1',
          action: 'Bash',
          summary: 'npm test',
          input: { command: 'npm test' },
        }),
      })
    })
    await chat.act(async () =>
      chat
        .field()
        .dispatchEvent(
          new chat.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
    )
    expect(interrupt, 'the turn is paused on the request, not stopped').not.toHaveBeenCalled()
  } finally {
    turn.release()
    await chat.unmount()
  }
})

test('copying a selection of the conversation puts its markdown on the clipboard', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'a', text: 'Summarise the change' }),
      event('turn_started', { turnId: 'a' }),
      event('content_delta', { turnId: 'a', text: '## Result\n\nThe **cache** is fixed.' }),
      event('turn_completed', { turnId: 'a' }),
    ],
  })
  try {
    const log = chat.host.querySelector('[role="log"]')!
    const heading = Array.from(log.querySelectorAll('h2')).find((node) => node.textContent === 'Result')!
    const paragraph = Array.from(log.querySelectorAll('p')).find((node) => node.textContent === 'The cache is fixed.')!
    const range = chat.dom.window.document.createRange()
    range.setStartBefore(heading)
    range.setEndAfter(paragraph)
    const selection = chat.dom.window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const written: Record<string, string> = {}
    const copy = new chat.dom.window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', {
      value: { setData: (type: string, value: string) => void (written[type] = value) },
    })
    await chat.act(async () => {
      paragraph.dispatchEvent(copy)
    })
    expect(copy.defaultPrevented).toBe(true)
    expect(written['text/plain']).toBe('## Result\n\nThe **cache** is fixed.')
    expect(written['text/html']).toContain('<h2>Result</h2>')
  } finally {
    await chat.unmount()
  }
})

// The `/` menu over a Claude Code chat whose CLI reported two commands.
async function mountCommandChat(sendTurn: SendTurn = async () => ({ ok: true })) {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'opus',
    capabilities: { reasoningEfforts: ['low', 'high'] },
    sendTurn,
  })
  const { resetConversationCommandsCache } = await import('./useConversationCommands')
  resetConversationCommandsCache()
  Object.assign(chat.dom.window.api, {
    conversationCommands: async ({ cli, cwd }: { cli: string; cwd: string }) => ({
      cli,
      cwd,
      fetchedAt: Date.now(),
      commands: [
        { name: 'compact', description: 'Summarize the conversation', source: 'cli' },
        { name: 'review', description: 'Review a pull request', argumentHint: '[pr-number]', source: 'custom' },
      ],
    }),
  })
  const { field } = chat
  const key = (name: string) =>
    chat.act(async () => {
      field().dispatchEvent(
        new chat.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      )
    })
  const options = () => Array.from(chat.dom.window.document.querySelectorAll('[role="option"]'))
  return { ...chat, field, key, options }
}

test('picking a command from the / menu inserts it as text with the caret after it, and shows what it takes', async () => {
  const chat = await mountCommandChat()
  try {
    await chat.act(async () => chat.type('/rev'))
    expect(chat.field().getAttribute('aria-expanded')).toBe('true')
    expect(chat.options().map((row) => row.textContent)).toEqual([expect.stringContaining('/review')])
    await chat.key('Enter')
    expect(chat.draft()).toBe('/review ')
    expect(chat.caret()).toBe('/review '.length)
    expect(chat.field().getAttribute('aria-expanded')).toBe('false')
    expect(chat.host.textContent).toContain('/review [pr-number]')
    await chat.act(async () => chat.type('/review 12'))
    expect(chat.host.textContent, 'the hint goes once the person types').not.toContain('[pr-number]')
  } finally {
    await chat.unmount()
  }
})

test('/model from the menu opens the model picker and leaves nothing to send', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountCommandChat(sendTurn)
  try {
    await chat.act(async () => chat.type('/mod'))
    expect(chat.options()[0]?.textContent).toContain('/model')
    await chat.key('Enter')
    expect(chat.draft()).toBe('')
    expect(chat.dom.window.document.querySelector('[role="listbox"][aria-label="Agent runtime"]')).not.toBeNull()
    expect(sendTurn).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})

test('/effort from the menu steps the chat to its next effort', async () => {
  const chat = await mountCommandChat()
  try {
    await chat.act(async () => chat.type('/eff'))
    await chat.key('Tab')
    expect(chat.draft()).toBe('')
    expect(chat.agent().conversationReasoningEffort).toBe('low')
  } finally {
    await chat.unmount()
  }
})

test('a / command the menu does not know is sent as typed', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountCommandChat(sendTurn)
  try {
    await chat.act(async () => chat.type('/zzz'))
    expect(chat.options()).toHaveLength(0)
    await chat.key('Enter')
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: '/zzz' })
  } finally {
    await chat.unmount()
  }
})

test('a sent picture’s bytes leave the view once the transcript has stored it, and the bubble keeps drawing it', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({ capabilities: { images: true }, sendTurn })
  const api = (chat.dom.window as unknown as { api: Record<string, unknown> }).api
  api.readImageDataUrl = async () => 'data:image/png;base64,iVBORw0KGgo='
  const reads: unknown[] = []
  api.conversationAttachment = async (input: unknown) => {
    reads.push(input)
    return { ok: false, message: 'not read' }
  }
  const bubbleImage = () => chat.host.querySelector('[role="log"] img')?.getAttribute('src')
  try {
    const paste = new chat.dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], files: [], types: ['text/plain'], getData: () => '/Users/dev/Desktop/shot.png' },
    })
    await chat.act(async () => {
      chat.field().dispatchEvent(paste)
    })
    await chat.act(async () => chat.type('What is wrong here?'))
    await chat.act(async () => chat.enter())
    const sent = sendTurn.mock.calls[0]![0] as { localTurnId: string; attachments: { id: string }[] }
    expect(bubbleImage()).toBe('data:image/png;base64,iVBORw0KGgo=')
    await chat.act(async () => {
      chat.emit({
        type: 'event',
        event: event('user_message', {
          turnId: 't1',
          text: 'What is wrong here?',
          localTurnId: sent.localTurnId,
          attachments: [{ id: sent.attachments[0]!.id, mediaType: 'image/png', byteLength: 8, ref: 'store/shot.png' }],
        }),
      })
    })
    // Drawn from the store's copy now, which the send seeded: nothing is read back.
    expect(bubbleImage()).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(reads).toEqual([])
  } finally {
    await chat.unmount()
  }
})

test('a turn’s steps rest folded, the latest one included; its agents are cards that open the Agents tab', async () => {
  // Turn ids of its own: a fold another test opened is remembered per turn.
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'fold-first', text: 'Check the build' }),
      event('turn_started', { turnId: 'fold-first' }),
      event('tool_started', { turnId: 'fold-first', toolUseId: 'fold-one', name: 'Read', input: { path: 'a.ts' } }),
      event('tool_output', { turnId: 'fold-first', toolUseId: 'fold-one', output: 'a', status: 'ok' }),
      event('tool_started', {
        turnId: 'fold-first',
        toolUseId: 'fold-agent',
        name: 'Agent',
        subagentLane: true,
        subagentType: 'Explore',
        input: { description: 'Map the test suites' },
      }),
      event('tool_output', { turnId: 'fold-first', toolUseId: 'fold-agent', output: 'Three suites.', status: 'ok' }),
      event('content_delta', { turnId: 'fold-first', text: 'It builds.' }),
      event('turn_completed', { turnId: 'fold-first' }),
    ],
  })
  const openPaneTab = vi.fn(() => 'agents-tab')
  const setActivePaneTab = vi.fn()
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState({ openPaneTab, setActivePaneTab } as never)
  const fold = () => chat.button('Worked for')
  try {
    expect(fold()?.textContent, 'the agent is not one of the steps').toContain('1 step')
    expect(fold()?.getAttribute('aria-expanded'), 'the latest turn rests folded').toBe('false')
    expect(chat.host.textContent, 'its steps are not drawn').not.toContain('a.ts')
    expect(chat.host.textContent).toContain('It builds.')
    const card = Array.from(chat.host.querySelectorAll('button')).find((item) =>
      item.getAttribute('aria-label')?.endsWith('Open in Agents'),
    )
    expect(card?.textContent).toContain('Explore agent')
    expect(card?.textContent).toContain('Map the test suites')
    await chat.act(async () => card!.click())
    expect(openPaneTab).toHaveBeenCalledWith('workspace', { kind: 'agents', activate: false })
    expect(setActivePaneTab, 'a docked Agents tab is shown in the pane').toHaveBeenCalledWith('workspace', 'agents-tab')
    await chat.act(async () => fold()!.click())
    expect(chat.host.textContent, 'opened, the fold shows the steps').toContain('a.ts')
  } finally {
    await chat.unmount()
  }
})

test('a replay plays the conversation back a reply at a time, stopping on each message', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 't1', text: 'Why does the build fail?' }),
      event('turn_started', { turnId: 't1' }),
      event('content_delta', { turnId: 't1', text: 'The barrel stopped exporting the pager.' }),
      event('turn_completed', { turnId: 't1' }),
      event('user_message', { turnId: 't2', text: 'Thanks for checking' }),
      event('turn_started', { turnId: 't2' }),
      event('content_delta', { turnId: 't2', text: 'Any time.' }),
      event('turn_completed', { turnId: 't2' }),
    ],
  })
  const replay = () => chat.host.querySelector<HTMLElement>('[data-conversation-replay]')
  const shown = () => replay()?.textContent ?? ''
  const press = (key: string) =>
    chat.act(async () => {
      chat.dom.window.document.activeElement!.dispatchEvent(
        new chat.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
    })
  try {
    // Started from the palette while the person is in the composer.
    const composer = chat.field()
    composer.focus()
    await chat.act(async () => {
      chat.dom.window.dispatchEvent(
        new chat.dom.window.CustomEvent('sprintengine:panel-command', { detail: { id: 'chat.replay.start' } }),
      )
    })
    // It opens on the first message, its reply not yet begun, with the keys in hand.
    expect(shown()).toContain('Why does the build fail?')
    expect(shown()).not.toContain('The barrel stopped')
    expect(shown()).toContain('1/2')
    expect(replay()!.contains(chat.dom.window.document.activeElement)).toBe(true)
    // The live chat stays mounted underneath, out of reach.
    expect(chat.field().closest('[inert]')).not.toBeNull()

    // Space plays the reply and stops on the next message.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await press(' ')
      expect(replay()!.querySelector('button[aria-label="Pause replay"]')).not.toBeNull()
      for (let step = 0; step < 40; step++) await chat.act(async () => vi.advanceTimersByTime(500))
    } finally {
      vi.useRealTimers()
    }
    expect(shown()).toContain('The barrel stopped exporting the pager.')
    expect(shown()).toContain('Thanks for checking')
    expect(shown()).not.toContain('Any time.')
    expect(shown()).toContain('2/2')
    expect(replay()!.querySelector('button[aria-label="Play replay"]')).not.toBeNull()

    // → finishes the last reply at once; ← goes back to the message that asked for it.
    await press('ArrowRight')
    expect(shown()).toContain('Any time.')
    expect(shown()).toContain('End of the conversation')
    await press('ArrowLeft')
    expect(shown()).not.toContain('Any time.')
    expect(shown()).toContain('Thanks for checking')

    // Esc leaves, and the live chat is back as it was, focus where it was.
    await press('Escape')
    expect(replay()).toBeNull()
    expect(chat.host.querySelector('[inert]')).toBeNull()
    expect(chat.host.textContent).toContain('Any time.')
    expect(chat.dom.window.document.activeElement).toBe(composer)
  } finally {
    await chat.unmount()
  }
})

test("a replay asked for from the tab's menu waits for the transcript, then opens on its first message", async () => {
  const { requestChatReplay } = await import('./chatReplayRequests')
  // The menu asks before the tab's chat has mounted, let alone read its transcript.
  requestChatReplay('workspace', 'agent')
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 't1', text: 'Walk me through the release' }),
      event('turn_started', { turnId: 't1' }),
      event('content_delta', { turnId: 't1', text: 'First, the changelog.' }),
      event('turn_completed', { turnId: 't1' }),
    ],
  })
  try {
    const replay = chat.host.querySelector<HTMLElement>('[data-conversation-replay]')
    expect(replay?.textContent).toContain('Walk me through the release')
    expect(replay?.textContent).not.toContain('First, the changelog.')
  } finally {
    await chat.unmount()
  }
})

test('the composer row is the New chat’s: the "+" opens attach and skills, with no paperclip or Skills chip beside it', async () => {
  const chat = await mountChat({ capabilities: { images: true, skills: 'workspace' } })
  try {
    const buttons = () => Array.from(chat.dom.window.document.querySelectorAll('button'))
    const named = (label: string) => buttons().find((item) => item.getAttribute('aria-label') === label)
    expect(named('Attach an image')).toBeUndefined()
    expect(buttons().some((item) => item.textContent?.trim() === 'Skills')).toBe(false)
    const plus = named('Options')
    expect(plus?.getAttribute('data-composer-options')).toBe('true')
    await chat.act(async () => plus!.click())
    const menu = chat.dom.window.document.querySelector('[role="menu"][aria-label="Options"]')
    expect(menu?.textContent).toContain('Attach files')
    expect(menu?.textContent).toContain('Skills, plugins & MCPs')
    // A running chat is a conversation already; it schedules a message only
    // where main is there to keep it (below).
    expect(menu?.querySelector('[role="group"][aria-label="Start as"]')).toBeNull()
    expect(menu?.querySelector('[data-composer-schedule]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('the "+" schedules the next message: Enter hands it to main for its time, and the tray says when it goes', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  type Message = { id: string; workspaceId: string; agentId: string; text: string; sendAt: number; createdAt: number }
  let state: { messages: Message[] } = { messages: [] }
  const updates: Array<Record<string, unknown>> = []
  const chat = await mountChat({
    capabilities: { skills: 'workspace' },
    sendTurn,
    api: {
      scheduledMessages: async () => state,
      onScheduledMessagesChanged: () => () => undefined,
      updateScheduledMessage: async (update: Record<string, unknown>) => {
        updates.push(update)
        if (update.kind === 'schedule')
          state = {
            messages: [
              {
                id: 'sm-1',
                workspaceId: update.workspaceId as string,
                agentId: update.agentId as string,
                text: update.text as string,
                sendAt: update.sendAt as number,
                createdAt: Date.now(),
              },
            ],
          }
        if (update.kind === 'delete') state = { messages: state.messages.filter((entry) => entry.id !== update.id) }
        return state
      },
    },
  })
  try {
    const doc = chat.dom.window.document
    const plus = Array.from(doc.querySelectorAll('button')).find(
      (item) => item.getAttribute('aria-label') === 'Options',
    )
    await chat.act(async () => plus!.click())
    const row = doc.querySelector<HTMLElement>('[role="menu"][aria-label="Options"] [data-composer-schedule="true"]')
    expect(row?.textContent?.trim()).toBe('Schedule')
    await chat.act(async () => row!.click())
    expect(chat.host.querySelector('[data-send-time-tag="true"]')).not.toBeNull()
    expect(chat.host.querySelector('[data-composer-schedule-send="true"]')?.textContent?.trim()).toBe('Schedule')

    await chat.act(async () => chat.type('Carry on with the migration.'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(sendTurn).not.toHaveBeenCalled()
    expect(updates[0]).toMatchObject({
      kind: 'schedule',
      workspaceId: 'workspace',
      agentId: 'agent',
      text: 'Carry on with the migration.',
    })
    expect(updates[0]!.sendAt as number).toBeGreaterThan(Date.now())
    expect(chat.draft()).toBe('')
    expect(chat.host.querySelector('[data-send-time-tag="true"]'), 'the next message sends as usual').toBeNull()

    const tray = chat.host.querySelector<HTMLElement>('[role="group"][aria-label="Scheduled message"]')
    expect(tray?.textContent).toContain('Sends ')
    expect(tray?.textContent).toContain('Carry on with the migration.')

    const edit = Array.from(tray!.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Edit')
    await chat.act(async () => edit!.click())
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(updates[1]).toEqual({ kind: 'delete', id: 'sm-1' })
    expect(chat.draft()).toBe('Carry on with the migration.')
    expect(chat.host.querySelector('[data-send-time-tag="true"]'), 'still set for its time').not.toBeNull()
    expect(chat.host.querySelector('[role="group"][aria-label="Scheduled message"]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('a chat whose provider reads no images still attaches files of any kind under the "+", by path', async () => {
  const chat = await mountChat({ capabilities: { skills: 'workspace' } })
  try {
    const plus = chat.host.querySelector<HTMLButtonElement>('[data-composer-options]')
    await chat.act(async () => plus!.click())
    const menu = chat.dom.window.document.querySelector('[role="menu"][aria-label="Options"]')
    expect(menu?.textContent).toContain('Attach files')
    expect(menu?.textContent).toContain('Skills, plugins & MCPs')
    const picker = chat.host.querySelector<HTMLInputElement>('input[type="file"]')
    expect(picker?.getAttribute('accept'), 'the dialog offers every kind of file').toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('the strip under the composer pins the context ring right, its tooltip the token counts', async () => {
  const chat = await mountChat({
    events: [
      event('user_message', { turnId: 'a', text: 'Earlier message' }),
      event('usage_updated', { inputTokens: 90_000, outputTokens: 400, contextWindow: 200_000, contextUsed: 76_000 }),
    ],
  })
  try {
    const strip = chat.host.querySelector('[data-conversation-strip]')
    const ring = strip?.querySelector<HTMLElement>('[data-strip-context] [role="img"]')
    const counts = `${(76_000).toLocaleString()} / ${(200_000).toLocaleString()} tokens`
    expect(ring?.getAttribute('aria-label')).toBe(`Context 38% used, ${counts}`)
    expect(ring?.closest('[data-strip-context]')?.className).toContain('ml-auto')
    await chat.act(async () => ring!.focus())
    expect(chat.dom.window.document.querySelector('[role="tooltip"]')?.textContent).toBe(counts)
    // The ring is the strip's; the old meter row above the composer row is gone.
    expect(chat.host.textContent).not.toContain('Context used:')
  } finally {
    await chat.unmount()
  }
})

test('a CLI chat’s ring takes its window from the CLI model catalog when the runtime names none', async () => {
  const chat = await mountChat({
    providerId: 'claude-agent',
    modelId: 'opus',
    cliModelCatalog: {
      'claude-code': { fetchedAt: 1, models: [{ id: 'opus', label: 'Opus', contextWindow: 200_000 }] },
    },
    events: [event('usage_updated', { contextUsed: 50_000 })],
  })
  try {
    const ring = chat.host.querySelector('[data-strip-context] [role="img"]')
    expect(ring?.getAttribute('aria-label')).toMatch(/^Context 25% used, /)
  } finally {
    await chat.unmount()
  }
})

test('with no usage reported the strip draws no ring, rather than an empty one', async () => {
  const chat = await mountChat({ providerModels: [{ id: 'mock-model', contextLength: 200_000 }] })
  try {
    expect(chat.host.querySelector('[data-strip-context]')).toBeNull()
  } finally {
    await chat.unmount()
  }
})

// The git reads a strip asks this machine for: the chat's checkout, its
// branch, and how many files it has changed.
const gitApi = (branch: string, files: { added: number; updated: number; removed: number } | null = null) => ({
  getGitRepoRoot: async (path: string) => path,
  getGitBranches: async () => ({ current: branch, branches: [branch] }),
  watchGitCheckout: () => () => undefined,
  getWorkspaceChangeSummary: async () => ({
    additions: 10,
    deletions: 2,
    changedFiles: files ? files.added + files.updated + files.removed : 0,
    scope: 'folder',
    ...(files ? { files } : {}),
  }),
})

test('the strip names the branch the agent is on and opens the file explorer from it; no worktree, no machine here', async () => {
  const chat = await mountChat({ api: gitApi('fix/cli-update-output') })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const strip = chat.host.querySelector('[data-conversation-strip]')!
    const branch = strip.querySelector<HTMLButtonElement>('[data-strip-branch]')
    expect(branch?.getAttribute('data-strip-branch')).toBe('fix/cli-update-output')
    expect(branch?.getAttribute('aria-label')).toBe('Branch fix/cli-update-output — open in file explorer')
    expect(branch?.textContent).toBe('fix/cli-update-output')
    // On this computer, on the workspace's own checkout: no machine, no worktree.
    expect(strip.querySelector('[data-strip-machine]')).toBeNull()
    expect(branch?.querySelector('svg')).toBeNull()
    // The project is the title bar's to name, not the strip's.
    expect(strip.textContent).not.toContain('project')
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const openPaneTab = vi.fn(() => null)
    await chat.act(async () => useWorkspaceStore.setState({ openPaneTab } as never))
    await chat.act(async () => branch!.click())
    expect(openPaneTab).toHaveBeenCalledWith('workspace', { kind: 'files' })
  } finally {
    await chat.unmount()
  }
})

test('an agent in a worktree of its own wears the worktree mark on its branch', async () => {
  const chat = await mountChat({
    api: gitApi('agent/rename-module'),
    agent: { execution: { mode: 'worktree', cwd: '/Users/dev/project/.worktrees/rename-module' } },
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const branch = chat.host.querySelector('[data-conversation-strip] [data-strip-branch]')
    expect(branch?.getAttribute('aria-label')).toBe('Branch agent/rename-module, in a worktree — open in file explorer')
    expect(branch?.querySelector('svg')).not.toBeNull()
  } finally {
    await chat.unmount()
  }
})

test('the strip’s diff counts are a split pill that opens the Git panel, and a clean checkout draws none', async () => {
  const chat = await mountChat({ api: gitApi('main', { added: 1, updated: 2, removed: 2 }) })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const pill = chat.host.querySelector<HTMLButtonElement>('[data-conversation-strip] [data-diff-stat-pill]')
    expect(pill?.getAttribute('aria-label')).toBe('1 file added, 2 updated, 2 removed — open changes')
    expect(pill?.textContent).toBe('+3−2')
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    const togglePaneKind = vi.fn(() => true)
    await chat.act(async () => useWorkspaceStore.setState({ togglePaneKind } as never))
    await chat.act(async () => pill!.click())
    expect(togglePaneKind).toHaveBeenCalledWith('workspace', 'git')
  } finally {
    await chat.unmount()
  }
  const clean = await mountChat({ api: gitApi('main', { added: 0, updated: 0, removed: 0 }) })
  try {
    await clean.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(clean.host.querySelector('[data-diff-stat-pill]')).toBeNull()
  } finally {
    await clean.unmount()
  }
})

test('Retry after a failed resume from Studio asks again as the person, without Studio’s name', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({
    events: [
      event('user_message', {
        turnId: 't1',
        text: '[SprintEngine Studio] Continue where you left off — your usage limit has reset.',
        origin: { kind: 'studio', reason: 'usage-resume' },
      }),
      event('turn_started', { turnId: 't1' }),
      event('turn_failed', { turnId: 't1', reason: 'runtime' }),
    ],
    sendTurn,
  })
  try {
    const retry = chat.button('Retry')
    expect(retry, 'the failed turn offers Retry').toBeDefined()
    await chat.act(async () => retry!.click())
    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(sendTurn.mock.calls[0]?.[0]).toMatchObject({
      message: 'Continue where you left off — your usage limit has reset.',
    })
  } finally {
    await chat.unmount()
  }
})

test('Retry after a failed turn on a launched agent’s news asks to carry on, rather than repeat the news as the person’s', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({
    events: [
      event('user_message', {
        turnId: 't1',
        text: '[SprintEngine Studio] Agent Builder, which you launched, finished its turn.',
        origin: { kind: 'studio', reason: 'agent-notice' },
      }),
      event('turn_started', { turnId: 't1' }),
      event('turn_failed', { turnId: 't1', reason: 'runtime' }),
    ],
    sendTurn,
  })
  try {
    const retry = chat.button('Retry')
    expect(retry, 'the failed turn offers Retry').toBeDefined()
    await chat.act(async () => retry!.click())
    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(sendTurn.mock.calls[0]?.[0]).toMatchObject({ message: 'Continue.' })
  } finally {
    await chat.unmount()
  }
})

test('Retry re-sends a failed message’s stored images', async () => {
  const sent: Record<string, unknown>[] = []
  const attachment = vi.fn(async () => ({ ok: true, mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' }))
  const chat = await mountChat({
    capabilities: { images: true },
    sendTurn: async (input) => {
      sent.push(input as Record<string, unknown>)
      return { ok: true }
    },
    api: { conversationAttachment: attachment },
    events: [
      // Image-only: the stored message names its picture and carries no words.
      event('user_message', {
        turnId: 't1',
        text: '',
        attachments: [{ id: 'img-1', mediaType: 'image/png', ref: 'sha256-abc', byteLength: 8, name: 'shot.png' }],
      }),
      event('turn_started', { turnId: 't1' }),
      event('turn_failed', { turnId: 't1', reason: 'runtime', message: 'Overloaded' }),
    ],
  })
  try {
    const retry = chat.button('Retry')
    expect(retry, 'a Retry is offered').toBeDefined()
    await chat.act(async () => retry!.click())
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(attachment).toHaveBeenCalledWith(expect.objectContaining({ ref: 'sha256-abc' }))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.attachments).toEqual([
      { id: 'img-1', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8, name: 'shot.png' },
    ])
  } finally {
    await chat.unmount()
  }
})

function answeredTurn(turnId: string, question: string, answer: string): ConversationEvent[] {
  return [
    event('user_message', { turnId, text: question }),
    event('turn_started', { turnId }),
    event('content_delta', { turnId, text: answer }),
    event('turn_completed', { turnId }),
  ]
}

test('Load earlier does not call the older replies it loads new; a reply finishing after it is', async () => {
  const older = [
    ...answeredTurn('o1', 'Old one', 'Old answer one.'),
    ...answeredTurn('o2', 'Old two', 'Old answer two.'),
  ]
  const recent = answeredTurn('n1', 'New one', 'New answer.')
  // Opened at its end, as a chat read to the end was left: a place remembered
  // mid-history from another test would page the history in by itself.
  const { rememberConversationScroll } = await import('./conversationViewState')
  rememberConversationScroll('workspace:agent', { offset: 0, atEnd: true })
  const chat = await mountChat({
    events: recent,
    folderPath: '/Users/dev/earlier',
    api: {
      conversationLoadEarlier: async () => ({ ok: true, page: { events: older, hasMore: false, beforeCursor: null } }),
    },
  })
  try {
    await chat.act(async () => {
      chat.emit({ type: 'snapshot', page: { events: recent, hasMore: true, beforeCursor: recent[0]!.seq! } })
      chat.emit({ type: 'synchronized', seq: recent.at(-1)!.seq! })
    })
    const load = chat.button('Load earlier')
    expect(load, 'the older page is offered').toBeDefined()
    await chat.act(async () => load!.click())
    // Over the Studio protocol the page arrives a few turns later.
    for (let turn = 0; turn < 50 && !chat.host.textContent?.includes('Old answer one.'); turn++)
      await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    expect(chat.host.textContent).toContain('Old answer one.')
    expect(chat.button('Jump to latest'), 'scrolled up into history, the pill only offers the way back').toBeDefined()
    expect(chat.host.textContent).not.toMatch(/\d+ new repl/)
    await chat.act(async () => {
      for (const next of answeredTurn('n2', 'Next', 'Next answer.')) chat.emit({ type: 'event', event: next })
    })
    for (let turn = 0; turn < 50 && !chat.button('1 new reply'); turn++)
      await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    expect(chat.button('1 new reply'), 'the one that finished since is news').toBeDefined()
  } finally {
    await chat.unmount()
  }
})

test('typing and a streamed reply leave the composer’s "+" menu as it was', async () => {
  const chat = await mountChat({
    capabilities: { images: true, skills: 'workspace' },
    events: [
      event('user_message', { turnId: 'live', text: 'And the other cache?' }),
      event('turn_started', { turnId: 'live' }),
    ],
  })
  try {
    expect(chat.host.querySelector('[data-composer-options]')).not.toBeNull()
    plusMenuRenders.count = 0
    for (const draft of ['W', 'Wh', 'Why', 'Why n', 'Why not']) await chat.act(async () => chat.type(draft))
    for (const text of ['The ', 'cache ', 'was ', 'keyed ', 'on the path.'])
      await chat.act(async () => chat.emit({ type: 'event', event: event('content_delta', { turnId: 'live', text }) }))
    const { flushPendingTokensForTests } = await import('./useConversationSession')
    await chat.act(async () => flushPendingTokensForTests())
    expect(chat.host.textContent).toContain('keyed on the path.')
    expect(plusMenuRenders.count).toBe(0)
  } finally {
    await chat.unmount()
  }
})

test('replies unseen past the top of the loaded page are read back to the one that was seen, and land below it', async () => {
  const { noteChatOpened, noteChatLeft } = await import('./unreadDivider')
  const turn = (id: string, at: number, answer: string) => [
    eventAt(at, 'user_message', { turnId: id, text: `Ask ${id}` }),
    eventAt(at + 100, 'turn_started', { turnId: id }),
    eventAt(at + 200, 'content_delta', { turnId: id, text: answer }),
    eventAt(at + 900, 'turn_completed', { turnId: id }),
  ]
  // Seen up to `a`; everything on the loaded page finished after the visit.
  const older = turn('a', 1_000, 'Seen answer.')
  const recent = [...turn('b', 3_000, 'First new answer.'), ...turn('c', 5_000, 'Second new answer.')]
  const { rememberConversationScroll } = await import('./conversationViewState')
  rememberConversationScroll('workspace:agent', { offset: 0, atEnd: true })
  const loadEarlier = vi.fn(async () => ({ ok: true, page: { events: older, hasMore: false, beforeCursor: null } }))
  scrolledToIndex.length = 0
  const chat = await mountChat({
    events: recent,
    folderPath: '/Users/dev/long-unseen',
    api: { conversationLoadEarlier: loadEarlier },
  })
  try {
    await chat.act(async () => {
      chat.emit({ type: 'snapshot', page: { events: recent, hasMore: true, beforeCursor: recent[0]!.seq! } })
      chat.emit({ type: 'synchronized', seq: recent.at(-1)!.seq! })
    })
    // Opened once its last page is in, as a chat in the sidebar is clicked.
    await chat.act(async () => noteChatOpened('workspace', 2_500, 10_000))
    for (let step = 0; step < 50 && !chat.host.textContent?.includes('Seen answer.'); step++)
      await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(loadEarlier, 'the page above is read for the reply that was seen').toHaveBeenCalledTimes(1)
    const divider = chat.host.querySelector('[role="separator"][aria-label="New since you last looked"]')
    expect(divider?.nextElementSibling?.textContent).toContain('First new answer.')
    const index = listedKeys.current.indexOf('assistant:b')
    expect(scrolledToIndex.at(-1), 'it lands at the divider once the page is in').toEqual({ index, viewPosition: 0 })
  } finally {
    noteChatLeft('workspace')
    await chat.unmount()
  }
})

test('a key typed in the transcript after clicking away from the composer lands in the composer', async () => {
  const chat = await mountChat({})
  try {
    await chat.act(async () => chat.type('Check the '))
    const transcript = chat.host.querySelector<HTMLElement>('[role="log"]')!
    const keydown = new chat.dom.window.KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true })
    await chat.act(async () => {
      transcript.dispatchEvent(keydown)
    })
    expect(keydown.defaultPrevented).toBe(true)
    expect(chat.draft()).toBe('Check the g')
  } finally {
    await chat.unmount()
  }
})

test('a chord, a navigation key or Space typed in the transcript stays where it was pressed', async () => {
  const chat = await mountChat({})
  try {
    const transcript = chat.host.querySelector<HTMLElement>('[role="log"]')!
    for (const init of [{ key: 'c', metaKey: true }, { key: 'ArrowDown' }, { key: 'Escape' }, { key: ' ' }]) {
      const keydown = new chat.dom.window.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      await chat.act(async () => {
        transcript.dispatchEvent(keydown)
      })
      expect(keydown.defaultPrevented, init.key).toBe(false)
    }
    expect(chat.draft()).toBe('')
  } finally {
    await chat.unmount()
  }
})

test('the transcript takes focus on a click, so what is typed next reaches the chat', async () => {
  const chat = await mountChat({})
  try {
    expect(chat.host.querySelector('[role="log"]')?.getAttribute('tabindex')).toBe('-1')
  } finally {
    await chat.unmount()
  }
})

test('Primary+Alt+Enter sends the draft and then opens New chat', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn })
  const { setAppCommandRunner } = await import('../../../commands/appCommandRunner')
  const ran: string[] = []
  const unregister = setAppCommandRunner((id) => {
    ran.push(id)
    return true
  })
  try {
    const primary = (chat.dom.window as unknown as { api: { platform: string } }).api.platform === 'darwin'
    const chord = { key: 'Enter', code: 'Enter', altKey: true, ...(primary ? { metaKey: true } : { ctrlKey: true }) }
    await chat.act(async () => {
      chat
        .field()
        .dispatchEvent(new chat.dom.window.KeyboardEvent('keydown', { ...chord, bubbles: true, cancelable: true }))
    })
    expect(sendTurn, 'an empty composer sends nothing').not.toHaveBeenCalled()
    expect(ran, 'and so stays in the chat').toEqual([])
    await chat.act(async () => chat.type('Next: the footer'))
    await chat.act(async () => {
      chat
        .field()
        .dispatchEvent(new chat.dom.window.KeyboardEvent('keydown', { ...chord, bubbles: true, cancelable: true }))
    })
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(sendTurn.mock.calls[0][0]).toMatchObject({ message: 'Next: the footer' })
    expect(ran).toEqual(['chat.new'])
  } finally {
    unregister()
    await chat.unmount()
  }
})

// From the palette, with the chat focused: the focused chat is the one restarted.
function restartSessionCommand(chat: { dom: JSDOM; field: () => HTMLElement }) {
  chat.field().focus()
  chat.dom.window.dispatchEvent(
    new chat.dom.window.CustomEvent('sprintengine:panel-command', { detail: { id: 'chat.restartSession' } }),
  )
}

test('Restart agent session ends the idle agent’s process the way Settle does, keeping the chat', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const conversationSessionSuspend = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn, api: { conversationSessionSuspend } })
  try {
    await chat.act(async () => chat.type('Hello'))
    await chat.act(async () => chat.enter())
    expect(sendTurn).toHaveBeenCalledOnce()
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'hello', text: 'Hello' }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 'hello' }) })
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'hello' }) })
    })
    await chat.act(async () => restartSessionCommand(chat))
    expect(conversationSessionSuspend).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session' })
  } finally {
    await chat.unmount()
  }
})

test('Restart agent session is refused while a turn is running', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const conversationSessionSuspend = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ sendTurn, api: { conversationSessionSuspend } })
  try {
    await chat.act(async () => chat.type('Go'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'running', text: 'Go' }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 'running' }) })
    })
    await chat.act(async () => restartSessionCommand(chat))
    expect(conversationSessionSuspend).not.toHaveBeenCalled()
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'running' }) })
    })
    await chat.act(async () => restartSessionCommand(chat))
    expect(conversationSessionSuspend, 'once the turn is over it goes ahead').toHaveBeenCalledOnce()
  } finally {
    await chat.unmount()
  }
})

test('Restart agent session in a chat with no agent running ends nothing, and says so', async () => {
  const conversationSessionSuspend = vi.fn(async () => ({ ok: true }))
  const chat = await mountChat({ api: { conversationSessionSuspend } })
  const { useToastStore } = await import('../../../store/toastStore')
  try {
    // Earlier cases' toasts are still in the one store.
    useToastStore.setState({ toasts: [] })
    await chat.act(async () => restartSessionCommand(chat))
    expect(conversationSessionSuspend).not.toHaveBeenCalled()
    const titles = useToastStore.getState().toasts.map((toast) => toast.title)
    expect(titles).toContain('No agent session to restart')
    expect(titles).not.toContain('Agent session restarted')
  } finally {
    await chat.unmount()
  }
})

test('a sent message has the working line under it before its turn starts, and not after the turn', async () => {
  let resolveSend!: (value: { ok: true }) => void
  const sendTurn = vi.fn<SendTurn>(() => new Promise((resolve) => (resolveSend = resolve)))
  const chat = await mountChat({ sendTurn })
  try {
    await chat.act(async () => chat.type('Hello'))
    await chat.act(async () => chat.enter())
    expect(sendTurn).toHaveBeenCalledOnce()
    expect(chat.host.textContent, 'heard at once, while the agent starts').toContain('Thinking…')
    await chat.act(async () => resolveSend({ ok: true }))
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'hello', text: 'Hello' }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 'hello' }) })
      chat.emit({ type: 'event', event: event('turn_completed', { turnId: 'hello' }) })
    })
    expect(chat.host.textContent).not.toContain('Thinking…')
  } finally {
    await chat.unmount()
  }
})

test('a reply queued behind a New chat’s first message comes back after it when the worktree fails', async () => {
  const sendTurn = vi.fn<SendTurn>(async () => ({ ok: true }))
  const worktree = deferredWorktree()
  const chat = await mountPendingChat({
    createGitWorktree: worktree.createGitWorktree,
    startAttempt: true,
    sendTurn,
    conversationSessionStart: sessionStartSpy(),
  })
  try {
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await chat.act(async () => chat.type('and the signup page'))
    await chat.act(async () => void chat.enter())
    expect(chat.draft()).toBe('')
    await chat.act(async () => worktree.settle({ ok: false, message: 'Could not fetch origin.' }))
    await chat.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(chat.draft(), 'the first message, then the reply').toBe('fix the login\nand the signup page')
    expect(sendTurn).not.toHaveBeenCalled()
  } finally {
    await chat.unmount()
  }
})
