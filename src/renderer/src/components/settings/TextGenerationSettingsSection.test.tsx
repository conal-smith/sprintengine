// @vitest-environment jsdom
import assert from 'node:assert/strict'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { TextGenerationWritingStyle } from '../../../../shared/text-generation/writing-style'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { TextGenerationSettingsSection } from './TextGenerationSettingsSection'

// Settings → Agents → Text generation: the writing style of drafted commit
// messages and pull requests, and the style guide field that shows only for
// the person's own instructions.

let root: Root
let container: HTMLElement

function withStyle(writingStyle: TextGenerationWritingStyle): void {
  useWorkspaceStore.setState((state) => ({
    ...state,
    appSettings: {
      ...state.appSettings,
      textGeneration: { enabled: true, engine: null, writingStyle },
    },
  }))
}

async function show(): Promise<void> {
  await act(async () => root.render(<TextGenerationSettingsSection />))
}

const style = () => useWorkspaceStore.getState().appSettings.textGeneration.writingStyle
const guideField = () => container.querySelector<HTMLTextAreaElement>('textarea')
const styleTrigger = () =>
  container.querySelector<HTMLElement>('[role="combobox"][aria-label="Commit and pull request style"]')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  withStyle({ mode: 'repository', instructions: '' })
})

test('matching the repository is the default, and shows no style guide field', async () => {
  withStyle({ mode: 'repository', instructions: '' })
  await show()
  assert.match(styleTrigger()?.textContent ?? '', /Match the repository/)
  assert.equal(guideField(), null)
})

test('Conventional Commits shows no style guide field either', async () => {
  withStyle({ mode: 'conventional', instructions: 'Kept for later.' })
  await show()
  assert.match(styleTrigger()?.textContent ?? '', /Conventional Commits/)
  assert.equal(guideField(), null)
})

test('my own instructions shows the guide, bounded, and stores what is typed when the field is left', async () => {
  withStyle({ mode: 'custom', instructions: 'Past tense.' })
  await show()
  const field = guideField()
  assert.ok(field)
  assert.equal(field.value, 'Past tense.')
  assert.equal(field.maxLength, 2_000)
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    field.focus()
    setValue.call(field, 'Past tense, area first.')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.equal(style().instructions, 'Past tense.', 'not stored per keystroke')
  await act(async () => {
    field.blur()
  })
  assert.deepEqual(style(), { mode: 'custom', instructions: 'Past tense, area first.' })
})
