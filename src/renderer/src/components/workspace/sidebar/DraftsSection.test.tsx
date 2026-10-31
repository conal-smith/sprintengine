// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { resetNewChatDraftsForTests, startAnotherNewChatDraft, writeNewChatDraft } from '../agentComposer/newChatDraft'
import { DraftsSection } from './DraftsSection'

// The sidebar's Drafts: one row per kept New chat draft, newest begun first,
// opened and thrown away from the row; nothing at all when none is kept.

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetNewChatDraftsForTests()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function render(props: Partial<Parameters<typeof DraftsSection>[0]> = {}) {
  const calls = { opened: [] as string[], deleted: [] as string[] }
  act(() =>
    root.render(
      <DraftsSection
        expanded
        onToggle={() => {}}
        projectOf={(folderPath) => ({ name: folderPath.split('/').pop()!, folderPath, color: null, unfiled: false })}
        openDraftId={null}
        onOpen={(id) => calls.opened.push(id)}
        onDelete={(id) => calls.deleted.push(id)}
        {...props}
      />,
    ),
  )
  return calls
}

const rows = () => [...host.querySelectorAll<HTMLElement>('[data-new-chat-draft]')]

test('no kept draft, no section', () => {
  writeNewChatDraft('window-1', { prompt: '  ' })
  render()
  expect(host.querySelector('section')).toBeNull()
})

test('each kept draft is a row with its project and first line, newest begun first', () => {
  writeNewChatDraft('window-1', { prompt: 'Fix the login redirect\nand the test', folderPath: '/Users/dev/acme' })
  startAnotherNewChatDraft('window-1')
  writeNewChatDraft('window-1', { prompt: 'Ask about the release' })
  render()
  expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual([
    'Draft: Ask about the release, in No project',
    'Draft: Fix the login redirect, in acme',
  ])
  expect(host.textContent).toContain('Drafts')
})

test('a row opens its draft, and its × throws it away without opening it', () => {
  writeNewChatDraft('window-1', { prompt: 'Keep me' })
  const calls = render()
  const [row] = rows()
  act(() => row!.click())
  act(() => host.querySelector<HTMLButtonElement>('[data-new-chat-draft-delete]')!.click())
  const id = row!.getAttribute('data-new-chat-draft')!
  expect(calls).toEqual({ opened: [id], deleted: [id] })
})

test('the draft New chat is showing is drawn selected', () => {
  writeNewChatDraft('window-1', { prompt: 'Open one' })
  render()
  const id = rows()[0]!.getAttribute('data-new-chat-draft')!
  render({ openDraftId: id })
  expect(rows()[0]!.getAttribute('aria-current')).toBe('true')
})

test('a draft typed into later shows up without the sidebar around it redrawing', () => {
  render()
  expect(rows()).toHaveLength(0)
  act(() => {
    writeNewChatDraft('window-1', { prompt: 'Typed after the list was drawn' })
  })
  expect(rows()).toHaveLength(1)
})
