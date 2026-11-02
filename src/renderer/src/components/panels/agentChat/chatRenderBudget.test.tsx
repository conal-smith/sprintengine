import { JSDOM } from 'jsdom'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionFrame,
  ConversationSubscribeInput,
} from '../../../../../shared/conversation-runtime'
import { installRenderCounter, type RenderCounter } from '../../../../../../tests/render-counter'

// What a streamed token costs a mounted chat, counted: React commits and
// component renders (tests/render-counter.ts), DOM mutations, and characters
// handed to the markdown parser. The counts are held as ceilings.
//
// Timed against production React when CHAT_BENCH_PROD is set, with the
// report printed; a development build spends most of a token in its own
// element bookkeeping:
//   NODE_ENV=production CHAT_BENCH_PROD=1 npx vitest run <this file>
// CHAT_BENCH_REPORT prints the counts without timing. CHAT_BENCH_TURNS sets
// how much history the streaming chat holds (10, one page, by default).
const PROD = vi.hoisted(() => {
  const prod = !!process.env.CHAT_BENCH_PROD
  if (prod) process.env.NODE_ENV = 'production'
  return prod
})

// What the markdown parser is handed, counted in characters: the work a
// streamed token costs in parsing, without timing it.
const parsed = vi.hoisted(() => ({ characters: 0 }))
vi.mock('react-markdown', async (original) => {
  const actual = await original<typeof import('react-markdown')>()
  const Markdown = (props: Parameters<typeof actual.default>[0]) => {
    parsed.characters += typeof props.children === 'string' ? props.children.length : 0
    return actual.default(props)
  }
  return { ...actual, default: Markdown }
})

// Every row mounted, with the list's own row memo: the transcript list keeps a
// row whose item and extra data are unchanged.
vi.mock('@legendapp/list/react', async () => {
  const { forwardRef, memo, useImperativeHandle, useRef } = await import('react')
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
  return {
    LegendList: forwardRef(function LegendList(
      {
        data,
        renderItem,
        keyExtractor,
        className,
        extraData,
      }: {
        data: unknown[]
        renderItem: (props: { item: unknown; index: number }) => ReactNode
        keyExtractor: (item: unknown) => string
        className?: string
        extraData?: unknown
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
            <ListRow key={keyExtractor(item)} item={item} index={index} extraData={extraData} render={renderItem} />
          ))}
        </div>
      )
    }),
  }
})

let installedCounter: RenderCounter | null = null

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

const REPLY = [
  '## What changed\n\n',
  'The cache was keyed on the **path** alone, so two checkouts of one repository shared an entry and ',
  'the second read the first one’s index. I keyed it on the checkout’s root as well and added a test.\n\n',
  '- `src/cache.ts` keys on `root + path`\n- `src/cache.test.ts` covers two checkouts\n- the old entries expire on their own\n\n',
  '```ts\nexport function cacheKey(root: string, path: string): string {\n  return `${root}\\0${path}`\n}\n\n',
  'export function read(root: string, path: string): Entry | undefined {\n  const key = cacheKey(root, path)\n',
  '  const entry = entries.get(key)\n  if (!entry) return undefined\n  entries.delete(key)\n  entries.set(key, entry)\n  return entry\n}\n```\n\n',
  'Run the suite with `npm test`; it passes locally. One thing to check before merging: ',
  'the migration drops entries written by an older build, which costs one cold read per file after the update.\n\n',
].join('')

function tokens(text: string, count: number): string[] {
  const out: string[] = []
  let source = ''
  while (source.length < count * 4) source += text
  for (let index = 0; index < count; index++) out.push(source.slice(index * 4, index * 4 + 4))
  return out
}

function history(turns: number): ConversationEvent[] {
  const events: ConversationEvent[] = []
  for (let turn = 0; turn < turns; turn++) {
    const turnId = `h${turn}`
    events.push(event('user_message', { turnId, text: `Question ${turn}: why does the cache miss?` }))
    events.push(event('turn_started', { turnId }))
    events.push(event('content_delta', { turnId, text: REPLY }))
    events.push(event('turn_completed', { turnId }))
  }
  return events
}

async function mountChat(events: ConversationEvent[]) {
  const mountStarted = performance.now()
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const frameQueue = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frameQueue.set(id, callback)
    return id
  }
  const cancelFrame = (id: number) => void frameQueue.delete(id)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Window: dom.window.Window,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: !PROD,
  }
  Object.assign(globalThis, globals)
  Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
  const frames: ((frame: ConversationSessionFrame) => void)[] = []
  let releaseSend: (() => void) | null = null
  let releaseStart: ((ok?: boolean) => void) | null = null
  let sessionStarts = 0
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
            id: 'mock',
            displayName: 'Mock',
            providerType: 'model-provider',
            models: [{ id: 'mock-model' }],
            capabilities: {},
          },
        ],
      }),
      conversationSecretStatus: async () => ({ ok: false, message: 'No secret' }),
      // Held until the test lets it go, as a CLI starting up holds it.
      conversationSessionStart: () =>
        new Promise((resolve) => {
          sessionStarts++
          releaseStart = (ok = true) =>
            resolve(
              ok
                ? {
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
                    },
                  }
                : { ok: false, message: 'The CLI did not start.' },
            )
        }),
      conversationSessionSendTurn: () =>
        new Promise((resolve) => {
          releaseSend = () => resolve({ ok: true })
        }),
      conversationThreads: async () => ({ ok: true, threads: [] }),
    },
  })
  // The counter walks every fiber on every commit, so a timed run goes
  // without. React reads the hook once, as it loads, so one serves the file.
  if (!PROD) installedCounter ??= installRenderCounter()
  const counter = installedCounter
  const { act: reactAct, createElement } = await import('react')
  const { flushSync } = await import('react-dom')
  const { createRoot } = await import('react-dom/client')
  // Production React has no act(): an update is flushed where it is made,
  // and a few macrotasks let effects and resolved promises land.
  const act = async (run: () => unknown) => {
    if (!PROD) return reactAct(async () => void (await run()))
    flushSync(() => void run())
    await Promise.resolve()
  }
  const settle = async () => {
    for (let round = 0; round < 5; round++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const { default: AgentChatView } = await import('../AgentChatView')
  const { EditorView } = await import('@codemirror/view')
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace',
        name: 'Project',
        folderPath: '/Users/dev/project',
        agents: {
          agent: {
            id: 'agent',
            name: 'Chat',
            runtimeKind: 'conversation',
            conversation: { providerId: 'mock', modelId: 'mock-model' },
          },
        },
      },
    ] as never,
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(AgentChatView, { workspaceId: 'workspace', agentId: 'agent' })))
  await settle()
  await act(async () => {
    frames.at(-1)?.({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
    frames.at(-1)?.({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
  })
  await settle()
  if (PROD || process.env.CHAT_BENCH_REPORT)
    process.stderr.write(
      `\nMOUNT events=${events.length} ms=${(performance.now() - mountStarted).toFixed(0)} nodes=${host.getElementsByTagName('*').length}\n`,
    )
  const { flushPendingTokensForTests } = await import('./useConversationSession')
  // A frame here also renders whatever tokens arrived since the last one: the
  // session renders streamed tokens on its own interval, which this bench
  // stands in for so each token is measured on its own.
  const runFrames = () => {
    flushPendingTokensForTests()
    const due = [...frameQueue.values()]
    frameQueue.clear()
    for (const callback of due) callback(performance.now())
  }
  const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  return {
    dom,
    host,
    act,
    settle,
    counter,
    runFrames,
    emit: (frame: ConversationSessionFrame) => frames.at(-1)?.(frame),
    releaseSend: () => releaseSend?.(),
    releaseStart: (ok?: boolean) => releaseStart?.(ok),
    get sessionStarts() {
      return sessionStarts
    },
    transcript: () => host.querySelector('[role="log"]')?.textContent ?? '',
    type: (value: string) => {
      const view = editor()
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: value.length },
        userEvent: 'input.type',
      })
    },
    enter: () =>
      host
        .querySelector<HTMLElement>('.cm-content')!
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
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

test('streaming 1000 tokens of prose and code stays within its render and parse budget', async () => {
  const chat = await mountChat(history(Number(process.env.CHAT_BENCH_TURNS ?? 10)))
  try {
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'live', text: 'And the other cache?' }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 'live' }) })
    })
    await chat.act(async () => chat.runFrames())
    let mutations = 0
    const observer = new chat.dom.window.MutationObserver((records) => void (mutations += records.length))
    observer.observe(chat.host, { subtree: true, childList: true, characterData: true, attributes: true })
    chat.counter?.reset()
    parsed.characters = 0
    const { Session } = await import('node:inspector/promises')
    const session = new Session()
    if (process.env.BENCH_PROFILE) {
      session.connect()
      await session.post('Profiler.enable')
      await session.post('Profiler.start')
    }
    const cpu = process.cpuUsage()
    const started = performance.now()
    for (const text of tokens(REPLY, 1000)) {
      await chat.act(async () => {
        chat.emit({ type: 'event', event: event('content_delta', { turnId: 'live', text }) })
        chat.runFrames()
      })
    }
    const elapsed = performance.now() - started
    const cpuMs = process.cpuUsage(cpu).user / 1000
    if (process.env.BENCH_PROFILE) {
      const { profile } = await session.post('Profiler.stop')
      ;(await import('node:fs')).writeFileSync(process.env.BENCH_PROFILE, JSON.stringify(profile))
    }
    mutations += observer.takeRecords().length
    observer.disconnect()
    if (PROD || process.env.CHAT_BENCH_REPORT)
      process.stderr.write(
        `\nSTREAM commits=${chat.counter?.commits} renders=${chat.counter?.totalRenders()} mutations=${mutations} parsedChars=${parsed.characters} ms=${elapsed.toFixed(0)} cpuMs=${cpuMs.toFixed(0)}\n`,
      )
    if (process.env.CHAT_BENCH_REPORT)
      process.stderr.write(
        (chat.counter?.table() ?? [])
          .slice(0, 60)
          .map(([name, count]) => `  ${name}: ${count}`)
          .join('\n') + '\n',
      )
    expect(chat.host.textContent).toContain('What changed')
    // Each token parses the segment it lands in, not the reply so far.
    expect(parsed.characters).toBeLessThanOrEqual(91_000)
    if (chat.counter) {
      expect(chat.counter.commits).toBeLessThanOrEqual(1_010)
      expect(chat.counter.totalRenders()).toBeLessThanOrEqual(39_400)
    }
  } finally {
    await chat.unmount()
  }
})

// One reply that is a single long code block: the shape that makes a tail
// segment grow without bound while it streams.
const LONG_CODE = (() => {
  const lines = ['Here is the whole file.\n\n```ts']
  for (let index = 0; index < 400; index++)
    lines.push(`export const entry${index} = cacheKey(root, 'src/module-${index}.ts') // entry ${index}`)
  return `${lines.join('\n')}\n\`\`\`\n\nThat is all of it.\n`
})()

test('streaming one long code block parses only its opener per token', async () => {
  const chat = await mountChat(history(2))
  try {
    await chat.act(async () => {
      chat.emit({ type: 'event', event: event('user_message', { turnId: 'live', text: 'Show the file' }) })
      chat.emit({ type: 'event', event: event('turn_started', { turnId: 'live' }) })
    })
    await chat.act(async () => chat.runFrames())
    const chunks: string[] = []
    for (let index = 0; index < LONG_CODE.length; index += 24) chunks.push(LONG_CODE.slice(index, index + 24))
    const times: number[] = []
    chat.counter?.reset()
    parsed.characters = 0
    const cpu = process.cpuUsage()
    const { Session } = await import('node:inspector/promises')
    const session = new Session()
    if (process.env.BENCH_PROFILE) {
      session.connect()
      await session.post('Profiler.enable')
      await session.post('Profiler.start')
    }
    for (const text of chunks) {
      const started = performance.now()
      await chat.act(async () => {
        chat.emit({ type: 'event', event: event('content_delta', { turnId: 'live', text }) })
        chat.runFrames()
      })
      times.push(performance.now() - started)
    }
    if (process.env.BENCH_PROFILE) {
      const { profile } = await session.post('Profiler.stop')
      ;(await import('node:fs')).writeFileSync(process.env.BENCH_PROFILE, JSON.stringify(profile))
    }
    const cpuMs = process.cpuUsage(cpu).user / 1000
    const tenth = Math.floor(times.length / 10)
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    if (PROD || process.env.CHAT_BENCH_REPORT)
      process.stderr.write(
        `\nLONG CODE chunks=${chunks.length} parsedChars=${parsed.characters} cpuMs=${cpuMs.toFixed(0)} total=${(mean(times) * times.length) | 0}ms first10%=${mean(times.slice(0, tenth)).toFixed(2)}ms/token last10%=${mean(times.slice(-tenth)).toFixed(2)}ms/token renders=${chat.counter?.totalRenders()}\n`,
      )
    if (process.env.CHAT_BENCH_REPORT)
      process.stderr.write(
        (chat.counter?.table() ?? [])
          .slice(0, 20)
          .map(([name, count]) => `  ${name}: ${count}`)
          .join('\n') + '\n',
      )
    expect(chat.host.textContent).toContain('entry399')
    // Without the fence fast path this is the whole block again on every
    // token: 17.4 million characters for this one.
    expect(parsed.characters).toBeLessThanOrEqual(20_000)
    if (chat.counter) expect(chat.counter.totalRenders()).toBeLessThanOrEqual(57_100)
  } finally {
    await chat.unmount()
  }
}, 120_000)

test('a first message shows in the transcript on Enter, before its session has started', async () => {
  const chat = await mountChat([])
  try {
    await chat.act(async () => chat.type('Why does the cache miss?'))
    const commitsBefore = chat.counter?.commits ?? 0
    await chat.act(async () => chat.enter())
    const enterCommits = (chat.counter?.commits ?? 0) - commitsBefore
    // On screen from the Enter's own commit, before any frame or IPC answer.
    expect(chat.transcript()).toContain('Why does the cache miss?')
    if (chat.counter) expect(enterCommits).toBeLessThanOrEqual(2)
    await chat.act(async () => chat.runFrames())
    expect(chat.sessionStarts).toBe(1)
    if (process.env.CHAT_BENCH_REPORT)
      process.stderr.write(
        `\nSEND visible=${chat.transcript().includes('Why does the cache miss?')} commits=${(chat.counter?.commits ?? 0) - commitsBefore}\n`,
      )
    expect(chat.transcript()).toContain('Why does the cache miss?')
    await chat.act(async () => chat.releaseStart())
    await chat.settle()
    expect(chat.transcript()).toContain('Why does the cache miss?')
  } finally {
    await chat.unmount()
  }
})

test('a first message whose session will not start leaves the transcript and goes back to the composer', async () => {
  const chat = await mountChat([])
  try {
    await chat.act(async () => chat.type('Why does the cache miss?'))
    await chat.act(async () => chat.enter())
    await chat.act(async () => chat.releaseStart(false))
    await chat.settle()
    expect(chat.transcript()).not.toContain('Why does the cache miss?')
    expect(chat.host.querySelector('.cm-content')?.textContent).toContain('Why does the cache miss?')
  } finally {
    await chat.unmount()
  }
})

test('the workspace record moving on what the chat does not read redraws none of it', async () => {
  const chat = await mountChat(history(10))
  try {
    const { useWorkspaceStore } = await import('../../../store/workspaceStore')
    chat.counter?.reset()
    // The visit stamp, written every few seconds while the chat is on screen,
    // and a layout write, as a tab click makes.
    await chat.act(async () => useWorkspaceStore.getState().recordWorkspaceVisit('workspace', Date.now()))
    await chat.act(async () =>
      useWorkspaceStore.setState((state) => ({
        workspaces: state.workspaces.map((workspace) => ({ ...workspace, layoutModel: { layout: {} } as never })),
      })),
    )
    await chat.settle()
    if (process.env.CHAT_BENCH_REPORT)
      process.stderr.write(`\nVISIT renders=${chat.counter?.totalRenders()} commits=${chat.counter?.commits}\n`)
    if (chat.counter) {
      expect(chat.counter.renders('ConversationChatBody')).toBe(0)
      expect(chat.counter.totalRenders()).toBe(0)
    }
  } finally {
    await chat.unmount()
  }
})

test('typing into a long chat redraws the composer, not the transcript', async () => {
  const chat = await mountChat(history(200))
  try {
    const text = 'Why does the cache miss on the second checkout?!!!'
    expect(text).toHaveLength(50)
    chat.counter?.reset()
    for (let length = 1; length <= text.length; length++) await chat.act(async () => chat.type(text.slice(0, length)))
    await chat.settle()
    if (process.env.CHAT_BENCH_REPORT) {
      process.stderr.write(
        `\nTYPE commits=${chat.counter?.commits} renders=${chat.counter?.totalRenders()} body=${chat.counter?.renders('ConversationChatBody')}\n`,
      )
      process.stderr.write(
        (chat.counter?.table() ?? [])
          .slice(0, 40)
          .map(([name, count]) => `  ${name}: ${count}`)
          .join('\n') + '\n',
      )
    }
    expect(chat.host.querySelector('.cm-content')?.textContent).toBe(text)
    if (chat.counter) {
      // What a keystroke has nothing to say to: the dock, the checklist, the
      // connection notice, the quote toolbar and the quoted passages' marks.
      for (const name of [
        'ConversationPendingDock',
        'ConversationTodoStrip',
        'StudioConnectionNotice',
        'QuoteSelectionToolbar',
        'QuoteHighlights',
      ])
        expect(chat.counter.renders(name), name).toBe(0)
      // The body still redraws once a keystroke while it holds the draft; the
      // ceiling is what that costs now (900 before the dock and tray rows were
      // memoized).
      expect(chat.counter.totalRenders()).toBeLessThanOrEqual(700)
    }
  } finally {
    await chat.unmount()
  }
}, 120_000)
