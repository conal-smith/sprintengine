import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { AppUpdateChannel, AppUpdateState, AppUpdateTrack } from '../../../../shared/electron-api'
import { REPOSITORY_URL } from '../../../../shared/releases-repo'
import { RailBrandMark, nightlyBuildTooltip, railBrandMarkTooltip } from './RailBrandMark'

// The "se" at the foot of the app rail: it opens the project's repository, and
// it wears the night tile only when main says the BUILD is a nightly, whatever
// channel the updater has been pointed at since, with a tooltip naming the
// version and the channel it follows.

const NIGHTLY = '0.6.0-nightly.20260923.41'

type Api = {
  updateGetState: () => Promise<AppUpdateState>
  onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => () => void
  openExternal: (url: string) => Promise<{ ok: true }>
}

let root: Root
let container: HTMLElement
let dom: JSDOM
let push: ((state: AppUpdateState) => void) | null
let opened: string[]

function stateFor(version: string, buildChannel: AppUpdateTrack, channel: AppUpdateChannel): AppUpdateState {
  return {
    status: 'idle',
    version,
    channel,
    buildChannel,
    packaged: channel !== 'dev',
    updateVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseNotesUrl: null,
    downloaded: false,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    autoDownload: false,
    installRequiresAdmin: false,
    installOutcome: null,
  }
}

function install(initial: AppUpdateState) {
  const api: Api = {
    updateGetState: async () => initial,
    onUpdateStateChanged: (cb) => {
      push = cb
      return () => {
        push = null
      }
    },
    openExternal: async (url) => {
      opened.push(url)
      return { ok: true }
    },
  }
  ;(window as unknown as { api: Api }).api = api
}

async function mount() {
  await act(async () => {
    root.render(<RailBrandMark />)
  })
}

function mark(): HTMLButtonElement {
  const button = container.querySelector('button')
  assert.ok(button, 'the mark renders')
  return button
}

async function hoverTooltip(): Promise<string | null> {
  await act(async () => {
    mark().dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
  return dom.window.document.querySelector('[role="tooltip"]')?.textContent ?? null
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.navigator = dom.window.navigator
  g.HTMLElement = dom.window.HTMLElement
  g.Node = dom.window.Node
  g.MouseEvent = dom.window.MouseEvent
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.getComputedStyle = dom.window.getComputedStyle
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  push = null
  opened = []
})

afterEach(async () => {
  await act(async () => root.unmount())
})

test('a stable build is the bare "se", with no tile', async () => {
  install(stateFor('0.5.2', 'stable', 'stable'))
  await mount()
  assert.equal(mark().textContent, 'se')
  assert.equal(mark().dataset.build, 'stable')
  assert.equal(container.querySelector('.brand-night-tile'), null)
  assert.equal(await hoverTooltip(), 'Open the GitHub repository')
})

test('a stable build following nightly is still not drawn as a nightly', async () => {
  install(stateFor('0.5.2', 'stable', 'nightly'))
  await mount()
  assert.equal(container.querySelector('.brand-night-tile'), null)
})

test('a nightly build wears the night tile, and its tooltip names the version and the channel', async () => {
  install(stateFor(NIGHTLY, 'nightly', 'nightly'))
  await mount()
  assert.equal(mark().dataset.build, 'nightly')
  assert.equal(container.querySelector('.brand-night-tile')?.textContent, 'se')
  const tip = await hoverTooltip()
  assert.equal(tip, `Open the GitHub repository. Nightly build ${NIGHTLY}. Updates from the nightly channel.`)
})

test('a nightly switched to stable keeps the tile and says it now follows stable', async () => {
  install(stateFor(NIGHTLY, 'nightly', 'nightly'))
  await mount()
  await act(async () => push?.(stateFor(NIGHTLY, 'nightly', 'stable')))
  assert.ok(container.querySelector('.brand-night-tile'))
  const tip = await hoverTooltip()
  assert.match(tip ?? '', /Following the stable channel/)
  assert.match(tip ?? '', new RegExp(NIGHTLY.replace(/\./g, '\\.')))
})

test('a click opens the repository', async () => {
  install(stateFor('0.5.2', 'stable', 'stable'))
  await mount()
  await act(async () => mark().click())
  assert.deepEqual(opened, [REPOSITORY_URL])
  assert.equal(REPOSITORY_URL, 'https://github.com/conal-smith/sprintengine')
})

test('the tooltip copy for each channel the updater can report', () => {
  const identity = (channel: AppUpdateChannel) => ({ version: NIGHTLY, buildChannel: 'nightly' as const, channel })
  assert.equal(nightlyBuildTooltip(identity('nightly')), `Nightly build ${NIGHTLY}. Updates from the nightly channel.`)
  assert.equal(
    nightlyBuildTooltip(identity('stable')),
    `Nightly build ${NIGHTLY}. Following the stable channel: the next stable release replaces it.`,
  )
  assert.equal(
    nightlyBuildTooltip(identity('dev')),
    `Nightly build ${NIGHTLY}. A development build; it does not update itself.`,
  )
  assert.equal(railBrandMarkTooltip(null), 'Open the GitHub repository')
})
