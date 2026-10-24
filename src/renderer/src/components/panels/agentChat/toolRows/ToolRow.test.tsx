import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  displayToolPath,
  forwardRowGroundClick,
  isPreviewableImagePath,
  previewsAsImage,
  toolHasBody,
  ToolBody,
  ToolRow,
} from './ToolRow'
import { ConversationLinkProvider } from '../conversationLinks'
import type { TranscriptToolEntry } from '../conversationProjection'
import { JSDOM } from 'jsdom'
import {
  IncrementalCodeTokenizer,
  loadCodeLanguage,
  normalizeCodeLanguage,
} from '../../../../lib/highlight/codeHighlight'

function tool(values: Partial<TranscriptToolEntry>): TranscriptToolEntry {
  return { kind: 'tool', id: 'tool', turnId: 'turn', name: 'Bash', status: 'done', ...values }
}

test('command body retains command, ANSI text, and a neutral nonzero exit status', () => {
  const row = tool({
    toolKind: 'command',
    input: { command: 'rg missing src' },
    output: '\u001b[31mNo matches\u001b[0m',
    exitCode: 1,
  })
  const body = renderToStaticMarkup(<ToolBody tool={row} />)
  expect(body).toContain('rg missing src')
  expect(body).toContain('No matches')
  expect(body).not.toContain('\u001b')
  expect(body).toContain('exit 1')
  expect(renderToStaticMarkup(<ToolRow tool={row} />)).not.toContain('data-tone="error"')
})

test('a non-zero exit is quiet on the glyph but never in quiet ink on the row', () => {
  const html = renderToStaticMarkup(
    <ToolRow tool={tool({ toolKind: 'command', input: { command: 'npm test' }, exitCode: 2 })} />,
  )
  const subtitle = Array.from(new JSDOM(html).window.document.querySelectorAll('span')).find(
    (span) => span.textContent === 'exit 2',
  )
  expect(subtitle?.className).toContain('--tone-error')
  expect(subtitle?.className).not.toContain('--text-disabled')
  const body = renderToStaticMarkup(
    <ToolBody tool={tool({ toolKind: 'command', input: { command: 'npm test' }, exitCode: 2 })} />,
  )
  expect(body).toContain('--tone-error)]">exit 2')
  expect(renderToStaticMarkup(<ToolBody tool={tool({ toolKind: 'command', exitCode: 0 })} />)).not.toContain(
    '--tone-error',
  )
})

test('a press on the row ground goes through the label button, and a portalled click is ignored', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  // What the transcript's capture handler sees: the disclosure button it
  // guards, whichever part of the row was pressed.
  const guarded: (Element | null)[] = []
  try {
    await act(async () =>
      root.render(
        <div
          onClickCapture={(event) =>
            guarded.push(event.target instanceof Element ? event.target.closest('button[aria-expanded]') : null)
          }
        >
          <ToolRow tool={tool({ id: 'ground-click', toolKind: 'command', input: { command: 'npm test' } })} />
        </div>,
      ),
    )
    const button = host.querySelector('button[aria-expanded]')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const chevron = host.querySelector('[data-tool-kind] > div > svg:last-child')!
    await act(async () => chevron.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(guarded.at(-1)).toBe(button)
    // A click React bubbled up from a menu portalled elsewhere in the page.
    const menu = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(menu)
    let clicks = 0
    const press = (target: Element) =>
      forwardRowGroundClick(
        { target, currentTarget: host.querySelector('[data-tool-kind] > div') } as never,
        { click: () => clicks++ } as unknown as HTMLButtonElement,
      )
    press(menu)
    expect(clicks).toBe(0)
    press(chevron)
    expect(clicks).toBe(1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('collapsed file subtitles are independent links, never nested inside the disclosure button', () => {
  const html = renderToStaticMarkup(
    <ToolRow tool={tool({ name: 'Read', toolKind: 'file_read', input: { path: 'src/app.ts' } })} />,
  )
  const document = new JSDOM(html).window.document
  const link = document.querySelector('[aria-label="Open src/app.ts"]')
  expect(link).not.toBeNull()
  expect(link?.parentElement?.closest('button')).toBeNull()
  expect(document.querySelector('button[aria-expanded="false"]')).not.toBeNull()
})

test('read previews, edits, todos, searches, and structured tools have concrete bodies', () => {
  const read = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_read',
        name: 'Read',
        input: { path: 'src/app.ts' },
        output: Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n'),
      })}
    />,
  )
  // A long read folds with the block's own control — one disclosure, not a
  // second one under it — and keeps every line, so its copy copies them all.
  expect(read.match(/Show all/g)).toHaveLength(1)
  expect(read).toContain('Show all 45 lines')
  expect(read).toContain('data-folded')
  expect(read).toContain('line 44')
  const edit = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_edit',
        name: 'Edit',
        input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' },
      })}
    />,
  )
  expect(edit).toContain('Changes in src/app.ts')
  expect(edit).toContain('+1 −1')
  const todo = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'todo',
        name: 'TodoWrite',
        input: { todos: [{ content: 'Test changes', status: 'completed' }] },
      })}
    />,
  )
  expect(todo).toContain('Test changes')
  expect(todo).toContain('checked')
  for (const kind of ['search', 'list', 'web', 'mcp', 'other'] as const) {
    expect(
      renderToStaticMarkup(
        <ToolBody tool={tool({ toolKind: kind, name: kind, input: { query: 'lookup' }, output: 'response text' })} />,
      ),
    ).toContain('response text')
  }
})

test('declined tool is explicit and full detail supersedes the persisted snippet', () => {
  expect(renderToStaticMarkup(<ToolBody tool={tool({ outputStatus: 'declined' })} />)).toContain(
    'Tool request declined',
  )
  const full = 'complete output\n'.repeat(4000)
  const markup = renderToStaticMarkup(
    <ToolBody
      tool={tool({ toolKind: 'command', output: 'snippet', truncated: true })}
      detail={{
        input: { command: 'printf output' },
        output: full,
        status: 'ok',
        totalBytes: full.length,
        clipped: false,
      }}
    />,
  )
  expect(markup).toContain('complete output')
  expect(markup).not.toContain('snippet')
  expect(markup.length).toBeGreaterThan(50_000)
})

test('truncated output is fetched only on request and failures can be retried', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  let calls = 0
  const full = 'full output\n'.repeat(5000)
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationToolDetail: async () => {
        if (++calls === 1) throw new Error('Temporarily unavailable')
        return {
          ok: true,
          detail: { input: { command: 'printf output' }, output: full, status: 'ok', totalBytes: full.length },
        }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationLinkProvider } = await import('../conversationLinks')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const click = (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)
    expect(button).toBeTruthy()
    button!.click()
  }
  try {
    await act(async () =>
      root.render(
        <ConversationLinkProvider
          workspaceId="tool-detail-test"
          workspaceRoot="/workspace/app"
          cwd="/workspace/app"
          agentId="agent"
        >
          <ToolRow
            tool={tool({
              id: 'large-tool',
              toolKind: 'command',
              input: { command: 'printf output' },
              output: 'snippet',
              truncated: true,
            })}
          />
        </ConversationLinkProvider>,
      ),
    )
    expect(calls).toBe(0)
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(calls).toBe(0)
    await act(async () => click('Show full output'))
    expect(calls).toBe(1)
    expect(host.textContent).toContain('Temporarily unavailable')
    await act(async () => click('Retry'))
    expect(calls).toBe(2)
    expect(host.textContent).not.toContain('snippet')
    expect(host.textContent!.length).toBeGreaterThan(50_000)
    // The virtualized timeline unmounts a row scrolled out of view; coming back
    // keeps the fetched output without asking for it again.
    const row = (
      <ConversationLinkProvider
        workspaceId="tool-detail-test"
        workspaceRoot="/workspace/app"
        cwd="/workspace/app"
        agentId="agent"
      >
        <ToolRow
          tool={tool({
            id: 'large-tool',
            toolKind: 'command',
            input: { command: 'printf output' },
            output: 'snippet',
            truncated: true,
          })}
        />
      </ConversationLinkProvider>
    )
    await act(async () => root.render(<div />))
    await act(async () => root.render(row))
    expect(calls).toBe(2)
    expect(host.textContent).not.toContain('snippet')
    expect(host.textContent!.length).toBeGreaterThan(50_000)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Node',
      'MutationObserver',
      'getComputedStyle',
      'IS_REACT_ACT_ENVIRONMENT',
    ]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a running tool shows how long it has been running, a finished one how long it took', () => {
  const startedAt = Date.now() - 5_000
  const running = renderToStaticMarkup(
    <ToolRow tool={tool({ status: 'running', startedAt, input: { command: 'npm test' } })} />,
  )
  expect(running).toMatch(/>[5-6]s</u)
  const done = new JSDOM(renderToStaticMarkup(<ToolRow tool={tool({ startedAt, completedAt: startedAt + 12_400 })} />))
    .window.document
  const duration = done.querySelector('[data-step-duration]')
  expect(duration?.textContent).toBe('12s')
  expect(duration?.parentElement?.className).toContain('tabular-nums')
  const quick = renderToStaticMarkup(<ToolRow tool={tool({ startedAt, completedAt: startedAt + 240 })} />)
  expect(quick).toContain('>0.2s<')
})

test('a step says when it ran: a finished one when it finished, a running one when it started', async () => {
  const { formatMessageDateTime } = await import('../liveElapsed')
  const startedAt = Date.now() - 5_000
  const reading = (row: TranscriptToolEntry) => {
    const time = new JSDOM(renderToStaticMarkup(<ToolRow tool={row} />)).window.document.querySelector('time')
    return { dateTime: time?.getAttribute('datetime'), full: time?.querySelector('.sr-only')?.textContent }
  }
  expect(reading(tool({ startedAt, completedAt: startedAt + 1_000 }))).toEqual({
    dateTime: new Date(startedAt + 1_000).toISOString(),
    full: `Finished ${formatMessageDateTime(startedAt + 1_000)}`,
  })
  expect(reading(tool({ status: 'running', startedAt, input: { command: 'npm test' } }))).toEqual({
    dateTime: new Date(startedAt).toISOString(),
    full: `Started ${formatMessageDateTime(startedAt)}`,
  })
})

async function withToolDetailDom(
  detail: (toolUseId: string) => { output: string },
  run: (harness: {
    calls: string[]
    show: (row: TranscriptToolEntry) => Promise<void>
    hide: () => Promise<void>
    click: (label: string) => Promise<void>
    expand: () => Promise<void>
    text: () => string
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const calls: string[] = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationToolDetail: async ({ toolUseId }: { toolUseId: string }) => {
        calls.push(toolUseId)
        return { ok: true, detail: { input: {}, status: 'ok', clipped: false, ...detail(toolUseId) } }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationLinkProvider } = await import('../conversationLinks')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const workspaceId = `tool-detail-${Math.random()}`
  try {
    await run({
      calls,
      show: (row) =>
        act(async () =>
          root.render(
            <ConversationLinkProvider
              workspaceId={workspaceId}
              workspaceRoot="/workspace/app"
              cwd="/workspace/app"
              agentId="agent"
            >
              <ToolRow tool={row} />
            </ConversationLinkProvider>,
          ),
        ),
      hide: () => act(async () => root.render(<div />)),
      click: (label) =>
        act(async () => {
          const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)
          expect(button, label).toBeTruthy()
          button!.click()
        }),
      expand: () =>
        act(async () => {
          host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
        }),
      text: () => host.textContent ?? '',
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const truncatedCommand = (id: string, values: Partial<TranscriptToolEntry> = {}) =>
  tool({ id, toolKind: 'command', input: { command: 'cat big.log' }, output: 'snippet', truncated: true, ...values })

test('fetched output is cached by size: a few very large outputs push the oldest out', async () => {
  // Three outputs of about 7 MB each in memory; a size budget keeps two.
  const huge = 'x'.repeat(3_500_000)
  await withToolDetailDom(
    () => ({ output: huge }),
    async ({ calls, show, hide, click, expand }) => {
      for (const id of ['first', 'second', 'third']) {
        await show(truncatedCommand(id))
        await expand()
        await click('Show full output')
        await hide()
      }
      expect(calls).toEqual(['first', 'second', 'third'])
      await show(truncatedCommand('third'))
      await hide()
      expect(calls).toHaveLength(3)
      await show(truncatedCommand('first'))
      await click('Show full output')
      expect(calls).toEqual(['first', 'second', 'third', 'first'])
    },
  )
})

test('output fetched while the tool runs is not cached and can be fetched again once it finishes', async () => {
  let version = 0
  await withToolDetailDom(
    () => ({ output: `output v${++version}` }),
    async ({ calls, show, hide, click, expand, text }) => {
      await show(truncatedCommand('live', { status: 'running' }))
      await expand()
      await click('Show full output')
      expect(text()).toContain('output v1')
      await click('Refresh output')
      expect(text()).toContain('output v2')
      await show(truncatedCommand('live'))
      await click('Show final output')
      expect(text()).toContain('output v3')
      expect(calls).toHaveLength(3)
      // Only the finished output is kept for the row's next mount.
      await hide()
      await show(truncatedCommand('live'))
      expect(text()).toContain('output v3')
      expect(calls).toHaveLength(3)
    },
  )
})

test('a tool row whose subject is a folder shows the path as text, never a file chip', () => {
  const html = renderToStaticMarkup(
    <ToolRow tool={tool({ name: 'Read', toolKind: 'file_read', input: { path: '/Users/dev/project' } })} />,
  )
  expect(html).not.toContain('aria-label="Open /Users/dev/project"')
  // The label names the folder read; the text beside it says where it is.
  expect(html).toContain('Read project')
  expect(html).toContain('/Users/dev<')
})

test('an opened step sits in one contained panel with a copy action, not loose text', () => {
  const body = renderToStaticMarkup(
    <ToolBody tool={tool({ toolKind: 'command', input: { command: 'git log' }, output: 'b43af0faa chore: tidy' })} />,
  )
  const document = new JSDOM(body).window.document
  const panel = document.querySelector('.rounded-sm.border')
  expect(panel?.textContent).toContain('git log')
  expect(panel?.textContent).toContain('b43af0faa chore: tidy')
  expect(document.querySelector('[aria-label="Copy output"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Copy command"]')).not.toBeNull()
  const search = renderToStaticMarkup(
    <ToolBody tool={tool({ toolKind: 'search', name: 'Grep', input: { pattern: 'uninstall' }, output: 'src/a.ts' })} />,
  )
  expect(new JSDOM(search).window.document.querySelector('.rounded-sm.border')?.textContent).toContain('src/a.ts')
})

test('a row names its file relative to the workspace and keeps the full path as the link target', () => {
  const html = renderToStaticMarkup(
    <ConversationLinkProvider workspaceId="w" cwd="/Users/dev/project" workspaceRoot="/Users/dev/project">
      <ToolRow tool={tool({ name: 'Read', toolKind: 'file_read', input: { path: '/Users/dev/project/src/app.ts' } })} />
    </ConversationLinkProvider>,
  )
  const document = new JSDOM(html).window.document
  // The label carries the file's name, so the link beside it names only the
  // folder — relative to the workspace — and still opens the file itself.
  const link = document.querySelector('[aria-label="Open /Users/dev/project/src/app.ts"]')
  expect(link?.textContent).toBe('src')
  expect(document.querySelector('button[aria-expanded]')?.textContent).toContain('Read app.ts')
  expect(displayToolPath('/tmp/shot.png', { cwd: '/Users/dev/project', workspaceRoot: '/Users/dev/project' })).toBe(
    '/tmp/shot.png',
  )
})

test('reading an image previews the picture instead of printing its bytes', () => {
  expect(isPreviewableImagePath('/tmp/Screenshot 2026-09-27 at 22.41.31.png')).toBe(true)
  expect(isPreviewableImagePath('src/app.ts')).toBe(false)
  const html = renderToStaticMarkup(
    <ToolBody
      tool={tool({ toolKind: 'file_read', name: 'Read', input: { path: '/tmp/shot.png' }, output: 'binary' })}
    />,
  )
  expect(html).not.toContain('binary')
  expect(html).not.toContain('ds-code-block')
})

test('an SVG read shows its markup, and a failed read shows why', () => {
  expect(previewsAsImage('/tmp/shot.png')).toBe(true)
  expect(previewsAsImage('assets/logo.svg')).toBe(false)
  const svg = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_read',
        name: 'Read',
        input: { path: 'assets/logo.svg' },
        output: '<svg viewBox="0 0 16 16"/>',
      })}
    />,
  )
  expect(svg).toContain('ds-code-block')
  expect(svg).toContain('viewBox')
  const failed = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_read',
        name: 'Read',
        input: { path: '/tmp/gone.png' },
        output: 'File does not exist.',
        outputStatus: 'error',
      })}
    />,
  )
  expect(failed).toContain('File does not exist.')
  expect(failed).not.toContain('no longer available')
})

test('each kind of step leads with its own glyph', () => {
  const cases = [
    [{ name: 'Read', toolKind: 'file_read', input: { path: 'src/app.ts' } }, 'file_read'],
    [{ name: 'Edit', toolKind: 'file_edit', input: { path: 'src/app.ts' } }, 'file_edit'],
    [{ name: 'Write', toolKind: 'file_write', input: { path: 'src/app.ts' } }, 'file_write'],
    [{ name: 'Bash', toolKind: 'command', input: { command: 'ls' } }, 'command'],
    [{ name: 'Grep', toolKind: 'search', input: { pattern: 'x' } }, 'search'],
    [{ name: 'WebFetch', toolKind: 'web', input: { url: 'https://example.com' } }, 'web'],
    [{ name: 'TodoWrite', toolKind: 'todo', input: {} }, 'todo'],
    [{ name: 'Task', toolKind: 'subagent', input: {} }, 'subagent'],
    [{ name: 'mcp__acme__lookup', toolKind: 'mcp', input: {} }, 'mcp'],
    [{ name: 'Mystery', toolKind: 'other', input: {} }, 'other'],
  ] as const
  for (const [values, glyph] of cases) {
    const document = new JSDOM(renderToStaticMarkup(<ToolRow tool={tool(values)} />)).window.document
    expect(document.querySelector('[data-tool-kind] [data-tool-glyph]')?.getAttribute('data-tool-glyph')).toBe(glyph)
  }
})

test('a step with nothing to show is a plain line: no disclosure, no chevron', () => {
  const rowOf = (values: Partial<TranscriptToolEntry>) =>
    new JSDOM(renderToStaticMarkup(<ToolRow tool={tool(values)} />)).window.document
  const empty = [
    { name: 'Mystery', toolKind: 'other', input: {} },
    { name: 'mcp__acme__ping', toolKind: 'mcp' },
    { name: 'TodoWrite', toolKind: 'todo', input: {}, output: '  ' },
  ] as const
  for (const values of empty) {
    const document = rowOf(values)
    expect(document.querySelector('[aria-expanded]'), values.name).toBeNull()
    expect(document.querySelector('button'), values.name).toBeNull()
    expect(document.querySelector('[data-tool-kind] > div > svg'), values.name).toBeNull()
    expect(document.querySelector('[data-tool-label] [data-tool-glyph]')).not.toBeNull()
    expect(document.querySelector('[data-tool-step-body]')).toBeNull()
  }

  // Anything that can still show something keeps its disclosure.
  const expandable: Partial<TranscriptToolEntry>[] = [
    { name: 'Mystery', toolKind: 'other', input: { id: 1 } },
    { name: 'Mystery', toolKind: 'other', output: 'done' },
    { name: 'Mystery', toolKind: 'other', status: 'running' },
    { name: 'Mystery', toolKind: 'other', truncated: true },
    { name: 'Mystery', toolKind: 'other', outputStatus: 'declined' },
    { name: 'Read', toolKind: 'file_read' },
    { name: 'Edit', toolKind: 'file_edit' },
    { name: 'Bash', toolKind: 'command', summary: 'npm test' },
  ]
  for (const values of expandable) {
    const document = rowOf(values)
    expect(document.querySelector('button[aria-expanded="false"]'), JSON.stringify(values)).not.toBeNull()
    expect(document.querySelector('[data-tool-kind] > div > svg:last-child')).not.toBeNull()
  }
})

test('a command sits on the terminal ground with its exit status toned by outcome', () => {
  const panel = (exitCode: number) =>
    new JSDOM(
      renderToStaticMarkup(
        <ToolBody tool={tool({ toolKind: 'command', input: { command: 'npm test' }, output: 'ok', exitCode })} />,
      ),
    ).window.document
  const passed = panel(0)
  expect(passed.querySelector('.rounded-sm.border')?.className).toContain('--terminal-bg')
  expect(passed.querySelector('[data-exit-tone]')?.getAttribute('data-exit-tone')).toBe('ok')
  expect(passed.querySelector('[data-exit-tone]')?.className).not.toContain('--tone-error')
  const failed = panel(2)
  expect(failed.querySelector('[data-exit-tone]')?.getAttribute('data-exit-tone')).toBe('error')
  expect(failed.querySelector('[data-exit-tone]')?.className).toContain('--tone-error')
})

test('a multi-line command keeps its line breaks', () => {
  const body = renderToStaticMarkup(
    <ToolBody tool={tool({ toolKind: 'command', input: { command: 'npm test \\\n  --reporter=dot' } })} />,
  )
  const document = new JSDOM(body).window.document
  const command = Array.from(document.querySelectorAll('span')).find((span) => span.textContent?.includes('npm test'))
  expect(command?.textContent).toBe('npm test \\\n  --reporter=dot')
  expect(command?.className).toContain('whitespace-pre-wrap')
})

test('a command is coloured as the shell reads it, and its plain words keep the terminal ink', async () => {
  const command = 'git log --oneline | grep "fix" > /tmp/fixes.txt'
  const shell = normalizeCodeLanguage('bash')!
  // What a mounted panel does once the grammar loads; the panel's first paint
  // reads the result back from the highlighter's cache.
  new IncrementalCodeTokenizer(await loadCodeLanguage(shell), shell).update(command, true)
  const html = renderToStaticMarkup(<ToolBody tool={tool({ toolKind: 'command', input: { command } })} />)
  const document = new JSDOM(html).window.document
  const line = Array.from(document.querySelectorAll('span.whitespace-pre-wrap')).find((span) =>
    span.textContent?.includes('git log'),
  )
  expect(line?.textContent).toBe(command)
  expect(html).toContain('color:var(--sem-syntax-string)')
  expect(html).not.toContain('color:var(--sem-syntax-foreground)')
  expect(document.querySelector('.rounded-sm.border')?.className).toContain('--terminal-bg')
})

test('a command shows as plain text until the shell grammar has loaded', () => {
  const command = 'echo "not yet tokenized" && ls -la'
  const html = renderToStaticMarkup(<ToolBody tool={tool({ toolKind: 'command', input: { command } })} />)
  expect(html).not.toContain('--sem-syntax-')
  expect(new JSDOM(html).window.document.body.textContent).toContain(command)
})

test('an edit preview leaves out the no-newline-at-end-of-file marker', () => {
  const body = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_edit',
        name: 'Edit',
        input: {
          path: 'src/app.ts',
          patch: '@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file',
        },
      })}
    />,
  )
  expect(body).toContain('new')
  expect(body).not.toContain('No newline at end of file')
})

test('an edit whose file the row already names shows no second file chip', () => {
  const body = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_edit',
        name: 'Edit',
        input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' },
      })}
    />,
  )
  expect(body).toContain('Changes in src/app.ts')
  expect(body).not.toContain('aria-label="Open src/app.ts"')
})

test('a long search output links only its first lines, and only words that look like paths', () => {
  const output = Array.from({ length: 400 }, (_, index) => `src/file${index}.ts:${index + 1}: match here`).join('\n')
  const document = new JSDOM(
    renderToStaticMarkup(
      <ConversationLinkProvider workspaceId="w" cwd="/Users/dev/project" workspaceRoot="/Users/dev/project">
        <ToolBody tool={tool({ toolKind: 'search', name: 'Grep', input: { pattern: 'match' }, output })} />
      </ConversationLinkProvider>,
    ),
  ).window.document
  // Every line is still there to read and copy.
  expect(document.body.textContent).toContain('src/file399.ts:400: match here')
  // Rendered as one text run after the linked head, not a node per word.
  const tail = Array.from(document.querySelectorAll('div')).find((div) =>
    Array.from(div.childNodes).some((node) => node.nodeType === 3 && node.textContent?.includes('src/file399.ts')),
  )
  expect(tail).toBeTruthy()
  const lastText = Array.from(tail!.childNodes).at(-1)
  expect(lastText?.nodeType).toBe(3)
  expect(lastText?.textContent).toContain('src/file200.ts')
  expect(lastText?.textContent).toContain('src/file399.ts')
})

test('a finished to-do is struck through and dimmed; its marks render', () => {
  const body = new JSDOM(
    renderToStaticMarkup(
      <ToolBody
        tool={tool({
          toolKind: 'todo',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Run the **markdown** tests', status: 'completed' },
              { content: 'Check the dock', status: 'in_progress' },
            ],
          },
        })}
      />,
    ),
  ).window.document
  const [done, active] = Array.from(body.querySelectorAll('li'))
  expect(done.getAttribute('data-todo-status')).toBe('completed')
  expect(done.querySelector('.line-through')?.textContent).toBe('Run the markdown tests')
  expect(done.querySelector('strong')?.textContent).toBe('markdown')
  expect(active.textContent).toContain('(in progress)')
  expect(active.querySelector('.line-through')).toBeNull()
})

test('a file step names its file once: the label has the name, the link beside it the folder', () => {
  const row = (path: string) =>
    new JSDOM(
      renderToStaticMarkup(
        <ConversationLinkProvider workspaceId="w" cwd="/Users/dev/project" workspaceRoot="/Users/dev/project">
          <ToolRow tool={tool({ name: 'Read', toolKind: 'file_read', input: { path } })} />
        </ConversationLinkProvider>,
      ),
    ).window.document.body.textContent
  expect(row('/Users/dev/project/src/shared/conversation/segments.ts')).toBe('Read segments.tssrc/shared/conversation')
  // At the top of the workspace there is no folder to name, and no second copy of the name.
  expect(row('/Users/dev/project/package.json')).toBe('Read package.json')
})

test('a generated picture shows under its row unopened, opens in the system viewer, and reveals where it was saved', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const opened: unknown[] = [],
    revealed: string[] = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      readImageDataUrl: async () => 'data:image/png;base64,iVBORw0KGgo=',
      openImageAttachment: async (input: unknown) => void opened.push(input),
      showItemInFolder: async (path: string) => void revealed.push(path),
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const path = '/data/conversation-images/session/ig_1.png'
  try {
    await act(async () =>
      root.render(
        <ConversationLinkProvider
          workspaceId="generated-image"
          workspaceRoot="/workspace/app"
          cwd="/workspace/app"
          agentId="agent"
        >
          <ToolRow
            tool={tool({
              id: 'ig_1',
              name: 'GenerateImage',
              toolKind: 'other',
              input: { path, prompt: 'A flat orange circle' },
              outputStatus: 'ok',
            })}
          />
        </ConversationLinkProvider>,
      ),
    )
    const image = host.querySelector<HTMLImageElement>('[data-generated-image] img')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(image?.getAttribute('alt')).toBe('A flat orange circle')
    expect(host.textContent).toContain('Generated image')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Open A flat orange circle"]')!.click(),
    )
    expect(opened).toEqual([{ mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' }])
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Reveal in Finder')!
        .click(),
    )
    expect(revealed).toEqual([path])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a remote chat asks its machine for a step’s picture by the step, and says where it is when that machine does not share it', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const asked: unknown[] = []
  const local: string[] = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      readImageDataUrl: async (path: string) => void local.push(path),
      meshConversationToolImage: async (input: { key: unknown; toolUseId: string }) => {
        asked.push(input)
        return input.toolUseId === 'old-machine'
          ? { ok: false, code: 'images_unsupported', message: 'This picture is on mac-mini.' }
          : { ok: true, dataUrl: `data:image/png;base64,${input.toolUseId}` }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationTransportProvider, createRemoteConversationTransport } = await import('../conversationTransport')
  const key = { connectionId: 'mac-mini', workspaceId: 'remote-workspace', agentId: 'agent' }
  const transport = createRemoteConversationTransport({ key, machineName: 'mac-mini', access: 'read' })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const render = (entry: TranscriptToolEntry) =>
    act(async () =>
      root.render(
        <ConversationTransportProvider value={transport}>
          <ConversationLinkProvider workspaceId="remote-workspace" workspaceRoot="" cwd="" agentId="agent">
            <ToolRow tool={entry} />
          </ConversationLinkProvider>
        </ConversationTransportProvider>,
      ),
    )
  try {
    // A picture made over there shows under its row, with no folder here to reveal.
    await render(
      tool({
        id: 'ig_2',
        name: 'GenerateImage',
        toolKind: 'other',
        input: { path: '[home]/Library/conversation-images/ig_2.png', prompt: 'A lighthouse' },
        outputStatus: 'ok',
      }),
    )
    expect(host.querySelector('[data-generated-image] img')?.getAttribute('src')).toBe('data:image/png;base64,ig_2')
    expect(host.textContent).not.toContain('Reveal in Finder')
    expect(asked).toEqual([{ key, toolUseId: 'ig_2' }])
    // A read of a picture, opened, shows it; a machine that does not share
    // pictures leaves it there, and says so.
    const openRead = async (id: string) => {
      await render(tool({ id, name: 'Read', toolKind: 'file_read', input: { path: 'shots/screen.png' } }))
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    }
    await openRead('read-shot')
    expect(host.querySelector('[data-tool-step-body] img')?.getAttribute('src')).toBe('data:image/png;base64,read-shot')
    await openRead('old-machine')
    expect(host.textContent).toContain('This image is on another machine.')
    expect(asked).toEqual([
      { key, toolUseId: 'ig_2' },
      { key, toolUseId: 'read-shot' },
      { key, toolUseId: 'old-machine' },
    ])
    expect(local, 'a remote path is never read off this disk').toEqual([])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test("a step's returned pictures are drawn in its body, one preview each", () => {
  const html = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        name: 'mcp__sprintengine-studio__browser_screenshot',
        output: 'Captured 1280×800.',
        images: [
          '/Users/dev/Studio/conversation-images/s/shot-1.png',
          '/Users/dev/Studio/conversation-images/s/shot-2.png',
        ],
      })}
    />,
  )
  const pictures = new JSDOM(html).window.document.querySelector('[data-tool-images]')
  expect(pictures?.children).toHaveLength(2)
  expect(html).toContain('Captured 1280×800.')
  expect(renderToStaticMarkup(<ToolBody tool={tool({ name: 'mcp__x__y', output: 'ok' })} />)).not.toContain(
    'data-tool-images',
  )
})

test('a step called with nothing that answered only with a picture draws the picture alone, with no `{}`', () => {
  const html = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        name: 'mcp__sprintengine-studio__browser_screenshot',
        input: {},
        output: '',
        images: ['/Users/dev/Studio/conversation-images/c1/shot-1.png'],
      })}
    />,
  )
  expect(html).toContain('data-tool-images')
  expect(html).not.toContain('{}')
})

test('a step that answered only with pictures still opens, to show them', () => {
  const shot = tool({ name: 'mcp__studio__browser_screenshot', input: {}, output: '', images: ['/Users/dev/a.png'] })
  expect(toolHasBody(shot, 'other')).toBe(true)
  expect(toolHasBody({ ...shot, images: undefined }, 'other')).toBe(false)
})
