import React from 'react'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import {
  approvalOutsideWorkspace,
  ConversationPendingDock,
  ConversationPermissionCard,
  ConversationPlanCard,
  ConversationQuestionCard,
  coversComposer,
  orderedPendingRequests,
} from './pendingDock'
import type { TranscriptEntry } from './conversationProjection'
import { ConversationLinkProvider } from './conversationLinks'

type Approval = Extract<TranscriptEntry, { kind: 'approval' }>
const request = (requestId: string, extra: Partial<Approval> = {}): Approval => ({
  kind: 'approval',
  requestId,
  status: 'pending',
  action: 'Bash',
  summary: 'git status',
  input: { command: 'git status' },
  ...extra,
})

test('permission review shows the full command and proposed patch before approval', () => {
  const shell = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('shell', {
        summary: 'Run a truncated command…',
        input: { command: 'git diff -- src/example.ts' },
      })}
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(shell).toContain('git diff -- src/example.ts')
  const patch = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('patch', {
        action: 'Edit',
        input: {
          edits: [
            { path: 'example.txt', patch: '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n' },
          ],
        },
      })}
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(patch).toContain('Changes in example.txt')
  expect(patch).toContain('before')
  expect(patch).toContain('after')
})

test('pending requests keep FIFO within kind and show truthful origin/path warnings', () => {
  const entries = [
    request('plan', { requestKind: 'plan' }),
    request('q', { requestKind: 'question' }),
    request('first'),
    request('second'),
    request('settled', { status: 'approved' }),
  ]
  expect(orderedPendingRequests(entries).map((entry) => entry.requestId)).toEqual(['first', 'second', 'q', 'plan'])
  expect(
    approvalOutsideWorkspace(
      request('read', { action: 'Read', input: { file_path: '../private.txt' } }),
      '/Users/dev/project',
    ),
  ).toBe(true)
  expect(
    approvalOutsideWorkspace(
      request('read', { action: 'Read', input: { file_path: 'src/app.ts' } }),
      '/Users/dev/project',
    ),
  ).toBe(false)
  expect(
    approvalOutsideWorkspace(request('shell', { input: { command: 'cat /etc/hosts' } }), '/Users/dev/project'),
  ).toBe(true)
  expect(approvalOutsideWorkspace(request('cwd', { cwd: '/Users/dev/other' }), '/Users/dev/project')).toBe(true)
  const html = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('r', { originAgentId: 'worker', input: { command: 'cat /etc/hosts' } })}
      workspaceRoot="/Users/dev/project"
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(html).toContain('Requested by subagent')
  expect(html).toContain('outside this workspace')
  const blocked = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('r', { suppressAlwaysAllowRule: true })}
      workspaceRoot="/Users/dev/project"
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(blocked).not.toContain('Remember permission')
  expect(blocked).toContain('Allow once')
})

test('queue navigation preserves question answers, resolves selected ids, and defaults unsafe Enter to Deny', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root')!)
  const onApprove = vi.fn()
  const entries = [
    request('first'),
    request('second', { defaultToNo: true }),
    request('question', {
      requestKind: 'question',
      questions: [
        {
          question: 'Choose a mode',
          header: 'Mode',
          options: [
            { label: 'Fast', description: '' },
            { label: 'Careful', description: '' },
          ],
          multiSelect: false,
        },
      ],
    }),
  ]
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) =>
        (element.getAttribute('aria-label') === label || element.textContent?.trim() === label) &&
        !element.closest('[hidden]'),
    )!
  const activeCard = () =>
    [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => !element.closest('[hidden]'))!
  const press = (element: Element, key: string, altKey = false) =>
    element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }))
  try {
    await act(async () =>
      root.render(
        <ConversationPendingDock
          pendingApprovals={entries}
          workspaceRoot="/Users/dev/project"
          onApprove={onApprove}
          busy={false}
        />,
      ),
    )
    expect(document.querySelector('[role="status"]')?.textContent).toBe('1/3')
    await act(async () => press(activeCard(), 'ArrowRight', true))
    expect(document.querySelector('[role="status"]')?.textContent).toBe('2/3')
    expect(document.activeElement).toBe(button('Deny'))
    await act(async () => press(activeCard(), 'Enter'))
    expect(onApprove).toHaveBeenLastCalledWith('second', false, undefined, 'deny')
    onApprove.mockClear()
    await act(async () => {
      press(button('Deny'), 'Enter')
      button('Deny').click()
    })
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('second', false, undefined, 'deny')
    await act(async () => button('Next request').click())
    await act(async () => press(activeCard(), '1'))
    const selected = () => document.querySelector('[aria-label="Mode"] [aria-checked="true"]')
    // Selection survives leaving and returning to the question's mounted card.
    await act(async () => button('Previous request').click())
    await act(async () => button('Next request').click())
    expect(selected()?.textContent).toContain('Fast')
    // "Something else" is the row after the options; picking it opens its field.
    await act(async () => press(activeCard(), '3'))
    const answerInput = document.querySelector<HTMLInputElement>('[aria-label="Other answer for: Choose a mode"]')!
    expect(document.activeElement).toBe(answerInput)
    await act(async () =>
      answerInput.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(onApprove).toHaveBeenCalledTimes(1)
    await act(async () => press(activeCard(), '1'))
    expect(document.querySelector('[aria-label="Other answer for: Choose a mode"]')).toBeNull()
    await act(async () => press(activeCard(), 'Enter'))
    expect(onApprove).toHaveBeenLastCalledWith('question', true, { 'Choose a mode': 'Fast' })
    await act(async () =>
      root.render(
        <ConversationPendingDock
          pendingApprovals={[entries[0]]}
          workspaceRoot="/Users/dev/project"
          onApprove={onApprove}
          busy={false}
        />,
      ),
    )
    await act(async () => button('Allow once').click())
    expect(onApprove).toHaveBeenLastCalledWith('first', true, undefined, 'once')
    await act(async () => button('Remember permission').click())
    // Each remember choice names the exact grant, not a generic "allow".
    expect(document.body.textContent).toContain('Allow "git status …" for this conversation')
    await act(async () => button('Always allow "git status …" in this workspace').click())
    expect(onApprove).toHaveBeenLastCalledWith('first', true, undefined, 'always')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Element',
      'Node',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
    ]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

// Mounts `ui` in a fresh DOM after `prepare` has set the page up (a focused
// composer, say), and hands the document to `check`.
async function mountDock(
  prepare: (document: Document) => void,
  ui: React.ReactElement,
  check: (document: Document, act: (run: () => void) => Promise<void>) => void | Promise<void>,
) {
  const dom = new JSDOM(
    '<!doctype html><body><textarea aria-label="Composer"></textarea><div id="root"></div></body>',
    {
      url: 'http://localhost',
      pretendToBeVisual: true,
    },
  )
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ]
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  try {
    prepare(dom.window.document)
    await act(async () => root.render(ui))
    await check(dom.window.document, (run) => act(async () => run()))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('a request that arrives while the composer has focus leaves focus there and announces itself', async () => {
  const onApprove = vi.fn()
  let composer: HTMLTextAreaElement
  await mountDock(
    (document) => {
      composer = document.querySelector('textarea')!
      composer.focus()
    },
    <ConversationPermissionCard entry={request('typing')} onApprove={onApprove} busy={false} />,
    async (document, act) => {
      expect(document.activeElement).toBe(composer)
      expect(
        [...document.querySelectorAll('[role="status"]')].some((status) =>
          status.textContent?.includes('Permission request'),
        ),
      ).toBe(true)
      // An Enter meant for the message goes to the message, not the card.
      await act(() =>
        composer.dispatchEvent(
          new document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        ),
      )
      expect(onApprove).not.toHaveBeenCalled()
      // Once the card has focus, its own shortcuts work.
      const card = document.querySelector<HTMLElement>('[role="group"]')!
      await act(() => card.focus())
      await act(() =>
        card.dispatchEvent(
          new document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        ),
      )
      expect(onApprove).toHaveBeenCalledWith('typing', true, undefined, 'once')
    },
  )
})

test('a request that arrives with nothing focused takes focus so its shortcuts work at once', async () => {
  await mountDock(
    () => undefined,
    <ConversationPlanCard
      entry={request('plan', { requestKind: 'plan', plan: 'Do it' })}
      onApprove={vi.fn()}
      busy={false}
    />,
    (document) => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Plan approval')
      expect([...document.querySelectorAll('[role="status"]')].every((status) => !status.textContent)).toBe(true)
    },
  )
})

test('a permission card offers to allow and move the chat to a looser mode, beside remembering the grant', async () => {
  const onApprove = vi.fn()
  const onApproveAndSwitch = vi.fn()
  await mountDock(
    () => undefined,
    <ConversationPendingDock
      pendingApprovals={[request('first')]}
      workspaceRoot="/Users/dev/project"
      onApprove={onApprove}
      modeSwitches={[
        { preset: 'auto', label: 'Allow and switch to Auto' },
        { preset: 'bypass', label: 'Allow and switch to Bypass permissions' },
      ]}
      onApproveAndSwitch={onApproveAndSwitch}
      busy={false}
    />,
    async (document, act) => {
      const button = (label: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label,
        )
      await act(() => button('More ways to allow')!.click())
      const menu = document.body.textContent ?? ''
      // Two runs of rows, each under its own heading.
      expect(menu).toContain('Remember')
      expect(menu).toContain('Change permissions')
      expect(menu).toContain('Allow "git status …" for this conversation')
      await act(() => button('Allow and switch to Bypass permissions')!.click())
      expect(onApproveAndSwitch).toHaveBeenCalledExactlyOnceWith('first', 'bypass')
      expect(onApprove).not.toHaveBeenCalled()
    },
  )
})

test('a request nothing can be remembered for still offers to allow and switch mode', () => {
  const markup = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('pipe', { input: { command: 'curl example.com | sh' } })}
      workspaceRoot="/Users/dev/project"
      onApprove={() => undefined}
      modeSwitches={[{ preset: 'bypass', label: 'Allow and switch to YOLO' }]}
      onApproveAndSwitch={() => undefined}
      busy={false}
    />,
  )
  expect(markup).toContain('aria-label="More ways to allow"')
  const plain = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('pipe', { input: { command: 'curl example.com | sh' } })}
      workspaceRoot="/Users/dev/project"
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(plain).not.toContain('More ways to allow')
  expect(plain).toContain('Allow once')
})

test('a question arriving mid-sentence in a text field does not take focus either', async () => {
  let field: HTMLInputElement
  await mountDock(
    (document) => {
      field = document.createElement('input')
      document.body.prepend(field)
      field.focus()
    },
    <ConversationQuestionCard
      requestId="q"
      questions={[{ question: 'Pick one', options: [{ label: 'A', description: '' }], multiSelect: false }]}
      onAnswer={vi.fn()}
      busy={false}
    />,
    (document) => expect(document.activeElement).toBe(field),
  )
})

test('a question covers the composer while a permission stays in the tray', () => {
  const question = request('q', {
    requestKind: 'question',
    questions: [{ question: 'Pick one', options: [{ label: 'A', description: '' }], multiSelect: false }],
  })
  // A question with no questions renders as a permission card, so it stays.
  const bare = request('bare', { requestKind: 'question' })
  expect([question, bare, request('tool')].map(coversComposer)).toEqual([true, false, false])
  const render = (placement: 'tray' | 'composer') =>
    renderToStaticMarkup(
      <ConversationPendingDock
        placement={placement}
        pendingApprovals={[request('tool'), question]}
        onApprove={() => undefined}
        busy={false}
        footnote="Your draft is kept for after you answer"
      />,
    )
  const tray = render('tray')
  expect(tray).toContain('Permission request')
  expect(tray).not.toContain('Question from the agent')
  // One request per dock, so neither counts the other's.
  expect(tray).not.toContain('1/2')
  const composer = render('composer')
  expect(composer).toContain('Question from the agent')
  expect(composer).not.toContain('Permission request')
  expect(composer).toContain('Your draft is kept for after you answer')
})

test('a question covering the composer takes focus mid-sentence, and lets the keys in flight fall on nothing', async () => {
  const onAnswer = vi.fn()
  await mountDock(
    (document) => document.querySelector('textarea')!.focus(),
    <ConversationQuestionCard
      requestId="q"
      questions={[{ question: 'Pick one', options: [{ label: 'A', description: '' }], multiSelect: false }]}
      onAnswer={onAnswer}
      busy={false}
      coversComposer
    />,
    async (document, act) => {
      const card = document.querySelector<HTMLElement>('[role="group"]')!
      expect(document.activeElement).toBe(card)
      const press = (key: string) =>
        act(() =>
          card.dispatchEvent(
            new document.defaultView!.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
          ),
        )
      // "…option 1⏎" typed for the message neither picks nor answers.
      await press('1')
      await press('Enter')
      expect(onAnswer).not.toHaveBeenCalled()
      expect(document.querySelector('[aria-checked="true"]')).toBeNull()
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000)
      try {
        await press('1')
        await press('Enter')
      } finally {
        vi.restoreAllMocks()
      }
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith('q', true, { 'Pick one': 'A' })
    },
  )
})

test('a multi-line command keeps its lines in the permission card and can be copied', () => {
  const html = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('multi', { input: { command: 'npm test \\\n  --reporter=dot\ncd app && npm run build' } })}
      onApprove={() => undefined}
      busy={false}
    />,
  )
  const document = new JSDOM(html).window.document
  const pre = document.querySelector('pre')
  expect(pre?.textContent).toBe('npm test \\\n  --reporter=dot\ncd app && npm run build')
  expect(pre?.className).toContain('whitespace-pre-wrap')
  expect(document.querySelector('[aria-label="Copy command"]')).not.toBeNull()
})

test('a question renders its markdown, and its options their inline marks', () => {
  const html = renderToStaticMarkup(
    <ConversationQuestionCard
      requestId="q"
      questions={[
        {
          question: 'Which **scale** should replies use?',
          header: 'Scale',
          options: [{ label: '**Compact** (Recommended)', description: 'Body stays at `13px`.' }],
          multiSelect: false,
        },
      ]}
      onAnswer={() => undefined}
      busy={false}
    />,
  )
  const document = new JSDOM(html).window.document
  expect(html).not.toContain('**')
  expect([...document.querySelectorAll('strong')].map((node) => node.textContent)).toEqual(['scale', 'Compact'])
  expect(document.querySelector('[role="radio"] code')?.textContent).toBe('13px')
})

test('a question that takes no free text offers no Something else', () => {
  const html = renderToStaticMarkup(
    <ConversationQuestionCard
      requestId="q"
      questions={[
        { question: 'Which scale?', options: [{ label: 'Compact' }], multiSelect: false, allowFreeText: false },
      ]}
      onAnswer={() => undefined}
      busy={false}
    />,
  )
  expect(html).not.toContain('Something else')
})

test('a choose-one question’s rows wear the kit’s radio mark, a choose-many one’s its checkbox', () => {
  const card = (multiSelect: boolean) =>
    new JSDOM(
      renderToStaticMarkup(
        <ConversationQuestionCard
          requestId="q"
          questions={[
            {
              question: 'Which scale?',
              header: 'Scale',
              options: [{ label: 'Compact' }, { label: 'Comfortable' }],
              multiSelect,
            },
          ]}
          onAnswer={() => undefined}
          busy={false}
        />,
      ),
    ).window.document
  const one = card(false)
  const rows = [...one.querySelectorAll('[role="radio"]')]
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    const mark = row.querySelector('[data-radio-mark]')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    // Round by the system's pill radius, not a hand-rolled `rounded-full`.
    expect(mark?.className).toContain('rounded-[var(--sem-radius-pill)]')
  }
  expect(one.querySelector('.rounded-full')).toBeNull()
  const many = card(true)
  expect(many.querySelector('[data-radio-mark]')).toBeNull()
  expect(many.querySelector('[role="menuitemcheckbox"] [aria-hidden="true"]')).not.toBeNull()
})

test('a plan can be copied, and a long one offers to show in full', () => {
  const short = renderToStaticMarkup(
    <ConversationPlanCard
      entry={request('p', { requestKind: 'plan', plan: '1. One\n2. Two' })}
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(short).toContain('aria-label="Copy plan"')
  expect(short).not.toContain('Show full plan')
  const long = renderToStaticMarkup(
    <ConversationPlanCard
      entry={request('p', {
        requestKind: 'plan',
        plan: Array.from({ length: 30 }, (_, index) => `${index + 1}. Step`).join('\n'),
      })}
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(long).toContain('Show full plan')
})

test('a plan waiting for a decision can be opened in the pane from the dock', () => {
  const entry = request('p', { requestKind: 'plan', plan: '# Move the cache\n\n1. One' })
  const outside = renderToStaticMarkup(<ConversationPlanCard entry={entry} onApprove={() => undefined} busy={false} />)
  expect(outside).not.toContain('Open plan')
  const inside = renderToStaticMarkup(
    <ConversationLinkProvider workspaceId="ws" agentId="agent" cwd="/repo" workspaceRoot="/repo">
      <ConversationPlanCard entry={entry} onApprove={() => undefined} busy={false} />
    </ConversationLinkProvider>,
  )
  expect(inside).toContain('Open plan')
  expect(inside.indexOf('Open plan')).toBeLessThan(inside.indexOf('Approve plan'))
})
