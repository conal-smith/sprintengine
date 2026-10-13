// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

import { useToastStore } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SettingCard } from '../ui'
import { FontAppearanceRows } from './FontAppearanceRows'

const queryLocalFonts = vi.fn(async () => [
  { family: 'Avenir' },
  { family: 'Fira Code' },
  { family: 'Fira Sans' },
  { family: 'Iosevka' },
  { family: '.SF NS' },
])

beforeAll(() => {
  Object.assign(window, { queryLocalFonts })
  // A canvas that measures Avenir and Fira Sans as the proportional faces they are.
  const context = {
    font: '',
    measureText(glyph: string) {
      const proportional = /"(Avenir|Fira Sans)"/.test(this.font)
      return { width: proportional && glyph === 'i' ? 4 : 10 }
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  )
})

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useWorkspaceStore.getState().setAppearanceInterfaceFont('')
  useWorkspaceStore.getState().setAppearanceCodeFont('')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <SettingCard>
        <FontAppearanceRows />
      </SettingCard>,
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useToastStore.setState({ toasts: [] })
})

const appearance = () => useWorkspaceStore.getState().appSettings.appearance
const trigger = (label: string) => host.querySelector<HTMLButtonElement>(`[data-font-picker-trigger="${label}"]`)!
const search = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!
const optionNames = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((option) => option.textContent)

async function open(label: string): Promise<void> {
  await act(async () => {
    trigger(label).click()
  })
}

function type(text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(search(), text)
    search().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string): void {
  act(() => {
    search().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

test('the font list is read when a picker first opens, and only once', async () => {
  // First in the file: the list is kept for the session, so a later case would
  // find it already read.
  expect(queryLocalFonts).not.toHaveBeenCalled()
  await open('Interface font')
  act(() => trigger('Interface font').click())
  await open('Code font')
  expect(queryLocalFonts).toHaveBeenCalledTimes(1)
})

test('each picker names the bundled face while nothing is chosen', () => {
  expect(trigger('Interface font').textContent).toContain('Inter')
  expect(trigger('Interface font').textContent).toContain('Default')
  expect(trigger('Code font').textContent).toContain('JetBrains Mono')
})

test('opening a picker lists Default and the installed families, each in its own face', async () => {
  await open('Interface font')
  expect(optionNames()).toEqual(['InterDefault', 'Avenir', 'Fira Code', 'Fira Sans', 'Iosevka'])
  const iosevka = Array.from(document.querySelectorAll<HTMLElement>('[role="option"] span[style]')).find(
    (span) => span.textContent === 'Iosevka',
  )
  expect(iosevka?.style.fontFamily).toMatch(/^"Iosevka", Inter/)
})

test('typing narrows the list, and Enter takes the highlighted family', async () => {
  await open('Interface font')
  type('fira')
  // The query itself comes last, for a face the list does not hold.
  expect(optionNames()).toEqual(['Fira Code', 'Fira Sans', 'firaUse this name'])
  press('ArrowDown')
  press('Enter')
  expect(appearance().interfaceFont).toBe('Fira Sans')
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(trigger('Interface font').textContent).toContain('Fira Sans')
})

test('Default puts the bundled face back', async () => {
  useWorkspaceStore.getState().setAppearanceInterfaceFont('Avenir')
  await open('Interface font')
  const first = document.querySelector<HTMLElement>('[role="option"]')!
  act(() => first.click())
  expect(appearance().interfaceFont).toBe('')
})

test('the code picker refuses a proportional family and says why', async () => {
  await open('Code font')
  type('Avenir')
  press('Enter')
  expect(appearance().codeFont).toBe('')
  expect(useToastStore.getState().toasts.at(-1)?.title).toBe('“Avenir” isn’t monospace')
})

test('the code picker takes a monospace family', async () => {
  await open('Code font')
  type('iosevka')
  press('Enter')
  expect(appearance().codeFont).toBe('Iosevka')
})
