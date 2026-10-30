// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { AppUpdateCheckResult, AppUpdateState } from '../../../../shared/electron-api'
import { useAppUpdateStore } from '../../store/appUpdateStore'
import { AppUpdateRailButton } from './AppUpdateRailButton'
import { resetAppUpdateToastForTests } from './manager/appUpdateToast'

// The rail's update glyph pressed through its steps: check, download, restart.

let root: Root
let host: HTMLDivElement
let calls: string[]

function state(patch: Partial<AppUpdateState>): AppUpdateState {
  return {
    status: 'idle',
    version: '0.5.2',
    channel: 'stable',
    buildChannel: 'stable',
    packaged: true,
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
    ...patch,
  }
}

const answer = (): Promise<AppUpdateCheckResult> =>
  Promise.resolve({ ok: true, state: {} as AppUpdateState, message: 'ok' })

beforeEach(() => {
  calls = []
  resetAppUpdateToastForTests()
  ;(window as unknown as { api: unknown }).api = {
    updateCheck: () => (calls.push('check'), answer()),
    updateDownload: () => (calls.push('download'), answer()),
    updateQuitAndInstall: () => (calls.push('install'), answer()),
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useAppUpdateStore.setState({ state: null })
})

async function render(patch: Partial<AppUpdateState> | null): Promise<void> {
  useAppUpdateStore.setState({ state: patch ? state(patch) : null })
  await act(async () => root.render(<AppUpdateRailButton />))
}

const button = () => host.querySelector<HTMLButtonElement>('button')

async function click(): Promise<void> {
  await act(async () => {
    button()?.click()
    // The restart asks main only after two frames have painted its toast.
    for (let pass = 0; pass < 3; pass += 1) await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('nothing on the rail until main says this build follows a train', async () => {
  await render(null)
  expect(button()).toBe(null)
  await render({ packaged: false })
  expect(button()).toBe(null)
})

test('quiet with nothing to take; a press checks', async () => {
  await render({})
  expect(button()?.getAttribute('aria-label')).toBe('Check for updates')
  expect(button()?.style.color).toBe('')
  await click()
  expect(calls).toEqual(['check'])
})

test('a found release lights the glyph; a press downloads it', async () => {
  await render({ status: 'available', updateVersion: '0.7.0' })
  expect(button()?.dataset.updatePhase).toBe('available')
  expect(button()?.style.color).toBe('var(--tone-accent)')
  await click()
  expect(calls).toEqual(['download'])
})

test('a press while downloading does nothing', async () => {
  await render({
    status: 'downloading',
    updateVersion: '0.7.0',
    progress: { percent: 50, transferred: 1, total: 2, bytesPerSecond: 1 },
  })
  expect(button()?.getAttribute('aria-label')).toBe('Downloading 0.7.0 (50%)')
  await click()
  expect(calls).toEqual([])
})

test('a downloaded release restarts into it when pressed', async () => {
  // No confirm provider mounted here, so the press goes straight through.
  await render({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' })
  expect(button()?.dataset.updatePhase).toBe('ready')
  await click()
  expect(calls).toEqual(['install'])
})
