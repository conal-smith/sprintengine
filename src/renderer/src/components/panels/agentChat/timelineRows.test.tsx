// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'
import { formatMessageDateTime } from './liveElapsed'
import { AssistantTurnBlock, TimelineRow, TurnErrorBlock, UserTimelineRow, type TimelineChrome } from './timelineRows'
import { selectionClipboard } from '../../../utils/selectionToMarkdown'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>
type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>

// The app's clipboard bridge, standing in for the main process: what a click
// copied is read off this list.
const written: string[] = []

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  written.length = 0
  ;(window as unknown as { api: unknown }).api = {
    clipboardWriteText: async (text: string) => {
      written.push(text)
    },
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
  return host
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click')
  await act(async () => (element as HTMLElement).click())
}

const button = (container: HTMLElement, name: string | RegExp) =>
  [...container.querySelectorAll('button')].find((candidate) => {
    const label = candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })

const chrome: TimelineChrome = { assistantName: 'Claude Code', onRetry: () => undefined, retryDisabled: false }

const user = (extra: Partial<UserEntry> = {}): UserEntry => ({
  kind: 'user',
  id: 'u1',
  seq: 1,
  text: 'Fix the flaky test',
  createdAt: Date.parse('2026-09-28T10:15:00Z'),
  ...extra,
})

const assistant = (extra: Partial<AssistantEntry> = {}): AssistantEntry => ({
  kind: 'assistant',
  turnId: 't1',
  text: 'Done.',
  reasoning: '',
  status: 'complete',
  startedAt: Date.parse('2026-09-28T10:15:00Z'),
  ...extra,
})

const tool = (id: string): TranscriptToolEntry => ({
  kind: 'tool',
  id,
  turnId: 't1',
  name: 'Read',
  status: 'done',
  input: { path: id },
  summary: id,
})

test('opened reasoning reads as markdown, not as its raw marks', async () => {
  const view = await mount(
    <AssistantTurnBlock
      entry={assistant({ reasoning: 'First **check the fixture**, then `a.ts`.\n\n- one\n- two' })}
      tools={[]}
      decisions={[]}
      chrome={chrome}
    />,
  )
  await click(button(view, /^Thought/))
  const body = view.querySelector('[data-reasoning-block]')!
  expect(body.querySelector('strong')?.textContent).toBe('check the fixture')
  expect(body.querySelector('code')?.textContent).toBe('a.ts')
  expect(body.querySelectorAll('li')).toHaveLength(2)
  expect(body.textContent).not.toContain('**')
})

test('a message offers a copy glyph named for what it copies', async () => {
  const view = await mount(<UserTimelineRow entry={user()} chrome={chrome} />)
  const copy = button(view, 'Copy message')
  expect(copy).toBeDefined()
  expect(copy!.textContent).not.toContain('Copy')
  await click(copy)
  expect(written).toEqual(['Fix the flaky test'])
})

test('an image-only message has no copy button, since it has no words to copy', async () => {
  const view = await mount(
    <UserTimelineRow
      entry={user({
        text: '',
        attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8 }],
      })}
    />,
  )
  expect(button(view, 'Copy message')).toBeUndefined()
})

test('copying a reply copies its prose between steps and its final text, in order', async () => {
  const view = await mount(
    <AssistantTurnBlock
      entry={assistant({
        text: 'All green.',
        intermediateText: [{ text: 'Reading the test first.', beforeToolUseId: 'b' }],
      })}
      tools={[tool('a'), tool('b')]}
      decisions={[]}
      chrome={chrome}
    />,
  )
  await click(button(view, 'Copy reply'))
  expect(written).toEqual(['Reading the test first.\n\nAll green.'])
})

test('a copied reply holds a follow-up Codex suggests as its label, as the page shows it', async () => {
  const view = await mount(
    <AssistantTurnBlock
      entry={assistant({ text: 'Next:\n\n- :codex-followup[Prepare print version]{prompt="Make it print-ready"}' })}
      tools={[]}
      decisions={[]}
      chrome={chrome}
    />,
  )
  await click(button(view, 'Copy reply'))
  expect(written).toEqual(['Next:\n\n- Prepare print version'])
})

test('a failed turn with nothing written offers no reply to copy', async () => {
  const view = await mount(
    <AssistantTurnBlock entry={assistant({ text: '', status: 'failed' })} tools={[]} decisions={[]} chrome={chrome} />,
  )
  expect(button(view, 'Copy reply')).toBeUndefined()
})

test('the message time is not a tab stop of its own and names the full local date', async () => {
  const at = Date.parse('2026-09-28T10:15:00Z')
  const view = await mount(<UserTimelineRow entry={user({ createdAt: at })} chrome={chrome} />)
  const time = view.querySelector('time')!
  expect(time.getAttribute('dateTime')).toBe('2026-09-28T10:15:00.000Z')
  expect(time.hasAttribute('tabindex')).toBe(false)
  expect(formatMessageDateTime(at)).toContain('2026')
  // A screen reader, which cannot hover for the tooltip, is read the full
  // date where the eye sees the short time.
  const spoken = [...time.querySelectorAll('span')].filter((span) => span.getAttribute('aria-hidden') !== 'true')
  expect(spoken.map((span) => span.textContent).join('')).toBe(formatMessageDateTime(at))
})

test('the turn fold is a disclosure with a chevron, naming the work it opens', async () => {
  const view = await mount(
    <AssistantTurnBlock
      entry={assistant({ startedAt: 0, completedAt: 5000 })}
      tools={[tool('a'), tool('b')]}
      decisions={[]}
      chrome={{ ...chrome, latestTurnId: 'later' }}
    />,
  )
  const fold = button(view, /^Worked for 5s/)!
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(fold.querySelector('svg')).not.toBeNull()
  const region = view.querySelector(`[id="${fold.getAttribute('aria-controls')}"]`)
  expect(region).not.toBeNull()
  expect(region!.textContent).not.toContain('Read')
  await click(fold)
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(region!.querySelector('button[aria-expanded]')).not.toBeNull()
})

test('what the agent made for the person to see stays out of the shut fold', async () => {
  const picture: TranscriptToolEntry = {
    kind: 'tool',
    id: 'picture',
    turnId: 't1',
    name: 'GenerateImage',
    status: 'done',
    input: { path: '/Users/dev/project/fox.png', prompt: 'A fox in the snow' },
  }
  const view = await mount(
    <AssistantTurnBlock
      entry={assistant({
        // A turn of its own: a fold another test opened is remembered per turn.
        turnId: 'shown',
        startedAt: 0,
        completedAt: 5000,
        intermediateText: [
          { text: 'Reading the brief first.', beforeToolUseId: 'a' },
          { text: 'Here is the layout:\n\n![Layout](/Users/dev/project/layout.png)', beforeToolUseId: 'b' },
        ],
      })}
      tools={[tool('a'), tool('b'), picture]}
      decisions={[]}
      chrome={chrome}
    />,
  )
  const fold = button(view, /^Worked for 5s · 2 steps/)!
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  const region = view.querySelector(`[id="${fold.getAttribute('aria-controls')}"]`)!
  expect(region.textContent).toBe('')
  expect(view.textContent).not.toContain('Reading the brief first.')
  expect(view.textContent).toContain('Here is the layout:')
  // The picture is drawn (here as its alt text: the test has no file to load).
  expect(view.textContent).toContain('[Image: Layout]')
  expect(view.querySelector('[data-tool-kind]')?.textContent).toContain('Generated image')
  await click(fold)
  // Opened, the fold holds the steps and the prose that was folded, and draws
  // nothing that is already shown under it a second time.
  expect(region.textContent).toContain('Reading the brief first.')
  expect(region.textContent).not.toContain('Here is the layout:')
  expect(region.textContent).not.toContain('Generated image')
  expect(view.textContent!.split('Here is the layout:')).toHaveLength(2)
})

test('an open tool group names the rail it controls', async () => {
  const view = await mount(
    <AssistantTurnBlock entry={assistant()} tools={[tool('a'), tool('b')]} decisions={[]} chrome={chrome} />,
  )
  const group = [...view.querySelectorAll('button[aria-expanded="false"]')].at(-1) as HTMLElement
  expect(group.hasAttribute('aria-controls')).toBe(false)
  await click(group)
  const rail = view.querySelector(`[id="${group.getAttribute('aria-controls')}"]`)
  expect(rail?.textContent).toContain('a')
})

test('the error details copy whole with one press', async () => {
  const detail = 'Error: 529 {"type":"overloaded_error"}'
  const view = await mount(
    <TurnErrorBlock entry={assistant({ status: 'failed', text: '', failureDetail: detail })} chrome={chrome} />,
  )
  expect(button(view, 'Copy error details')).toBeUndefined()
  await click(button(view, 'Show details'))
  await click(button(view, 'Copy error details'))
  expect(written).toEqual([detail])
})

test('a selection across whole turns copies what was said, and none of the chrome around it', async () => {
  const view = await mount(
    <>
      <TimelineRow row={{ kind: 'user', id: 'u1', entry: user({ skills: ['review'] }) }} chrome={chrome} />
      <TimelineRow
        row={{
          kind: 'assistant',
          id: 't1',
          entry: assistant({
            text: 'All **green** now.',
            durationMs: 42_000,
            startedAt: 0,
            completedAt: 42_000,
            reasoning: 'Check the fixture first.',
            reasoningDurationMs: 3_000,
            intermediateText: [{ text: 'Reading the test first.', beforeToolUseId: 'b.ts' }],
          }),
          tools: [tool('a.ts'), tool('b.ts')],
          decisions: [],
        }}
        chrome={chrome}
      />
    </>,
  )
  // Every disclosure open, so the steps and the reasoning are on the page to
  // be selected across.
  for (const disclosure of view.querySelectorAll('button[aria-expanded="false"]')) await click(disclosure)
  expect(view.textContent).toContain('42s')
  expect(view.textContent).toContain('Check the fixture first.')

  const selection = document.getSelection()!
  selection.selectAllChildren(view)
  const copied = selectionClipboard(selection, view)!

  expect(copied.text).toBe('Fix the flaky test\n\nReading the test first.\n\nAll **green** now.')
  for (const chromeText of ['42s', 'Thought', 'Check the fixture', 'Worked for', 'a.ts', 'review', 'Copy'])
    expect(copied.text).not.toContain(chromeText)
})

test('a message Studio sent the chat reads as Studio’s note, not the person’s bubble', async () => {
  const container = await mount(
    <UserTimelineRow
      entry={user({
        text: '[SprintEngine Studio] Continue where you left off — your usage limit has reset.',
        origin: { kind: 'studio', reason: 'usage-resume' },
      })}
      chrome={{ ...chrome, rewindEnabled: true, onRestoreDraft: () => undefined }}
    />,
  )
  const notice = container.querySelector('[data-studio-notice="usage-resume"]')
  expect(notice?.textContent).toContain('SprintEngine Studio · Continue where you left off')
  expect(notice?.textContent).not.toContain('[SprintEngine Studio]')
  expect(container.textContent).not.toContain('You said')
  // None of the person's message actions: there is nothing of theirs to edit.
  expect(container.querySelectorAll('button')).toHaveLength(0)

  // Files it attached by path are named under it, from its list.
  await act(async () =>
    root!.render(
      <UserTimelineRow
        entry={user({
          text: '[SprintEngine Studio] The agent you started finished.',
          origin: { kind: 'studio', reason: 'agent-notice' },
          files: [{ path: '/repo/notes/report.md' }],
        })}
        chrome={chrome}
      />,
    ),
  )
  expect(container.querySelector('[data-studio-notice="agent-notice"]')?.textContent).toContain('report.md')
  expect(container.textContent).not.toContain('You said')

  // The same words without an origin are the person's.
  await act(async () => root!.render(<UserTimelineRow entry={user({ text: 'Continue' })} chrome={chrome} />))
  expect(container.querySelector('[data-studio-notice]')).toBeNull()
  expect(container.textContent).toContain('You said')
})
