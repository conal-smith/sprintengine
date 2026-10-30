// @vitest-environment jsdom
// The question card's "Something else" row, answered by typing into the field
// it opens. Kept apart from `pendingDock.test.tsx`, which builds its DOM by
// hand, where React never read a typed change.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ConversationQuestion } from '../../../../../shared/conversation-runtime'
import { ConversationQuestionCard } from './pendingDock'

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(
  question: ConversationQuestion,
  onAnswer: (requestId: string, approved: boolean, answers?: Record<string, string>) => void,
) {
  await act(async () =>
    root!.render(<ConversationQuestionCard requestId="q" questions={[question]} onAnswer={onAnswer} busy={false} />),
  )
}

const field = (question: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="Other answer for: ${question}"]`)
const answerButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Answer')!

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a choose-one question can be answered in words alone, by picking Something else', async () => {
  const onAnswer = vi.fn()
  await mount(
    { question: 'Which scale?', options: [{ label: 'Compact' }, { label: 'Comfortable' }], multiSelect: false },
    onAnswer,
  )
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const other = () => rows().find((row) => row.textContent?.includes('Something else'))!
  expect(rows()).toHaveLength(3)
  // No field until Something else is picked: it is an answer, not a note.
  expect(field('Which scale?')).toBeNull()
  await act(async () => rows()[0].click())
  await act(async () => other().click())
  expect(other().getAttribute('aria-checked')).toBe('true')
  // Picking it takes the place of the option picked before it.
  expect(rows()[0].getAttribute('aria-checked')).toBe('false')
  expect(document.activeElement).toBe(field('Which scale?'))
  // Picked but still empty, there is nothing to send yet.
  expect(answerButton().disabled).toBe(true)
  await type(field('Which scale?')!, 'Neither, match the editor')
  await act(async () => answerButton().click())
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('q', true, { 'Which scale?': 'Neither, match the editor' })
})

test('picking an option after Something else closes its field and drops the words', async () => {
  const onAnswer = vi.fn()
  await mount({ question: 'Which scale?', options: [{ label: 'Compact' }], multiSelect: false }, onAnswer)
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  await act(async () => rows()[1].click())
  await type(field('Which scale?')!, 'Something bigger')
  await act(async () => rows()[0].click())
  expect(field('Which scale?')).toBeNull()
  await act(async () => answerButton().click())
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('q', true, { 'Which scale?': 'Compact' })
})

test('a choose-many question sends the typed words after its picks', async () => {
  const onAnswer = vi.fn()
  await mount(
    { question: 'Which checks?', options: [{ label: 'Lint' }, { label: 'Tests' }], multiSelect: true },
    onAnswer,
  )
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
  await act(async () => rows()[1].click())
  await act(async () => rows()[2].click())
  // Something else sits beside the picks here, rather than replacing them.
  expect(rows()[1].getAttribute('aria-checked')).toBe('true')
  await type(field('Which checks?')!, 'and the e2e suite')
  await act(async () => answerButton().click())
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('q', true, { 'Which checks?': 'Tests, and the e2e suite' })
})
