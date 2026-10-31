// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { NewProjectResult } from '../../../../../shared/electron-api'
import { NewProjectStep, type NewProjectRequest } from './NewProjectStep'

// The New project step. What it must never do is reach GitHub on its own:
// publishing is off until ticked, private unless public is picked, and the
// request that goes to main carries `confirmed` only after the person said yes
// to a second screen that names the repository. `onCreate` is a fake here, so
// nothing in this file can make a repository anywhere.

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let ownerCalls = 0
;(window as unknown as { api: unknown }).api = {
  platform: 'darwin',
  listGitHubOwners: async () => {
    ownerCalls += 1
    return { ok: true, login: 'dev', orgs: ['acme'] }
  },
  openDir: async () => null,
}

let container: HTMLDivElement
let root: Root
let requests: NewProjectRequest[]
let done: number

beforeEach(() => {
  ownerCalls = 0
  requests = []
  done = 0
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
      <NewProjectStep
        defaultParent="/Users/dev/code"
        onBack={() => {}}
        onCreate={async (request) => {
          requests.push(request)
          const result: NewProjectResult = {
            ok: true,
            path: `/Users/dev/code/${request.name}`,
            repository: null,
            warning: null,
          }
          return result
        }}
        onDone={() => {
          done += 1
        }}
      />,
    )
  })
}

async function typeName(value: string): Promise<void> {
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')
  assert.ok(field)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  assert.ok(
    found,
    `no "${label}" button in: ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`,
  )
  return found as HTMLButtonElement
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
}

test('a project without GitHub is created at once, and asks nobody about owners', async () => {
  await render()
  await typeName('notes')
  await click(button('Create project'))
  assert.deepEqual(requests, [{ parentDir: '/Users/dev/code', name: 'notes', publish: null }])
  assert.equal(done, 1)
  assert.equal(ownerCalls, 0)
})

test('a name that cannot be a repository disables Create', async () => {
  await render()
  await typeName('my app')
  assert.equal(button('Create project').disabled, true)
  assert.match(container.textContent ?? '', /letters, numbers, dots, dashes and underscores/u)
})

test('publishing asks first, names the private repository, and only then sends a confirmed request', async () => {
  await render()
  await typeName('notes')
  const publish = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  assert.ok(publish)
  assert.equal(publish.checked, false, 'publishing starts off')
  await click(publish)
  assert.equal(ownerCalls, 1)

  await click(button('Create and publish…'))
  assert.deepEqual(requests, [], 'the first press only asks')
  assert.match(container.textContent ?? '', /Create a private repository on GitHub\?/u)
  assert.match(container.textContent ?? '', /dev\/notes/u)

  // Back leaves without sending anything.
  await click(button('Back'))
  assert.deepEqual(requests, [])

  await click(button('Create and publish…'))
  await click(button('Create repository'))
  assert.deepEqual(requests, [
    {
      parentDir: '/Users/dev/code',
      name: 'notes',
      publish: { owner: null, visibility: 'private', confirmed: true },
    },
  ])
  assert.equal(done, 1)
})
