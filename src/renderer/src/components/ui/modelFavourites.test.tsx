// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  __resetModelFavouritesForTest,
  modelFavouriteKey,
  toggleModelFavourite,
  useModelFavourites,
} from './modelFavourites'

const STORAGE_KEY = 'sprintengine.model-favourites'
const OPUS = modelFavouriteKey('claude-code', 'claude-opus-5-5')
const CODEX = modelFavouriteKey('codex', 'gpt-5.5')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let seen: string[] = []

function Probe(): null {
  seen = useModelFavourites()
  return null
}

function mountProbe(): void {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(<Probe />))
}

/** What another Studio window's write looks like from here. */
function writeFromAnotherWindow(list: string[] | null, key: string | null = STORAGE_KEY): void {
  if (list === null) window.localStorage.clear()
  else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: list === null ? null : JSON.stringify(list) }))
  })
}

beforeEach(() => {
  window.localStorage.clear()
  __resetModelFavouritesForTest()
  seen = []
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
})

test('a star set in another window shows in this one', () => {
  mountProbe()
  expect(seen).toEqual([])
  writeFromAnotherWindow([OPUS])
  expect(seen).toEqual([OPUS])
})

test('a write under another key leaves the list as it was', () => {
  mountProbe()
  const before = seen
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([OPUS]))
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'sprintengine.something-else', newValue: '1' }))
  })
  expect(seen).toBe(before)
})

test('another window clearing storage clears the stars here', () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([OPUS]))
  mountProbe()
  expect(seen).toEqual([OPUS])
  writeFromAnotherWindow(null, null)
  expect(seen).toEqual([])
})

test("toggling in a window that has not caught up keeps the other window's star", () => {
  mountProbe()
  // The other window's write lands in storage, but this window's copy is
  // still the empty one it read — the event has not arrived yet.
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([OPUS]))
  act(() => toggleModelFavourite(CODEX))
  expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual([OPUS, CODEX])
  expect(seen).toEqual([OPUS, CODEX])
})

test('unstarring reads the stored list, not the stale copy', () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([OPUS]))
  mountProbe()
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([OPUS, CODEX]))
  act(() => toggleModelFavourite(OPUS))
  expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual([CODEX])
  expect(seen).toEqual([CODEX])
})

test('a corrupted stored value reads as no stars', () => {
  window.localStorage.setItem(STORAGE_KEY, '{not json')
  mountProbe()
  expect(seen).toEqual([])
  act(() => toggleModelFavourite(OPUS))
  expect(seen).toEqual([OPUS])
})
