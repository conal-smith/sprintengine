// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { resetProjectLogos } from '../../../utils/projectLogos'
import { nearestPresetHue, ProjectIconDialog } from './ProjectIconDialog'

// The project icon picker: a monogram saves as a setting the sidebar reads, a
// file the logo guards refuse is said and cannot be saved, and Detected
// clears the override.

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FOLDER = '/Users/dev/my-app'
let pickedFile: string | null = null
;(window as unknown as { api: unknown }).api = {
  platform: 'darwin',
  detectProjectLogo: async () => null,
  openProjectIconFile: async () => pickedFile,
  readProjectIconFile: async (path: string) =>
    path.endsWith('scripted.svg') ? null : { path, mtimeMs: 1, dataUrl: 'data:image/png;base64,AAAA' },
}

let container: HTMLDivElement
let root: Root
let closed = 0

const icons = () => useWorkspaceStore.getState().appSettings.projectIcons ?? {}

beforeEach(() => {
  closed = 0
  pickedFile = null
  resetProjectLogos()
  useWorkspaceStore.getState().setProjectIcon(FOLDER, null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <ProjectIconDialog
        folderPath={FOLDER}
        projectHue={250}
        onClose={() => {
          closed += 1
        }}
      />,
    )
  })
}

function byText(label: string, selector = 'button, [role="radio"]'): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === label)
  assert.ok(found, `no "${label}"`)
  return found
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
}

test('the monogram starts from the name and the nearest named hue, and saves', async () => {
  assert.equal(nearestPresetHue(250), 255)
  assert.equal(nearestPresetHue(359), 345)
  await render()
  await click(byText('Monogram'))
  const letters = document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')
  assert.equal(letters?.value, 'MA')
  await click(byText('Save'))
  assert.deepEqual(Object.values(icons()), [{ kind: 'monogram', text: 'MA', hue: 255 }])
  assert.equal(closed, 1)
})

test('a file the guards refuse is said, and Save stays off', async () => {
  await render()
  await click(byText('Image file'))
  pickedFile = '/Users/dev/art/scripted.svg'
  await click(byText('Choose file…'))
  assert.match(document.body.textContent ?? '', /cannot be a project icon/u)
  assert.equal((byText('Save') as HTMLButtonElement).disabled, true)

  pickedFile = '/Users/dev/art/mark.png'
  await click(byText('Choose another…'))
  await click(byText('Save'))
  assert.deepEqual(Object.values(icons()), [{ kind: 'file', path: '/Users/dev/art/mark.png' }])
})

test('Detected clears the override', async () => {
  useWorkspaceStore.getState().setProjectIcon(FOLDER, { kind: 'monogram', text: 'X', hue: 25 })
  await render()
  await click(byText('Detected'))
  await click(byText('Save'))
  assert.deepEqual(icons(), {})
})
