// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { useWorkspaceStore } from '../store/workspaceStore'
import { applyChatAppearance, useAppTheme } from './useAppTheme'
import { clockFormat, setClockFormat } from '../utils/clockFormat'

const html = document.documentElement

afterEach(() => {
  applyChatAppearance(html, 100, 'full')
})

test('the default chat appearance leaves the theme inks alone', () => {
  applyChatAppearance(html, 100, 'full')
  expect(html.getAttribute('data-chat-width')).toBe('full')
  expect(html.hasAttribute('data-chat-contrast')).toBe(false)
  expect(html.style.getPropertyValue('--chat-contrast-keep')).toBe('')
})

test('lower contrast keeps a share of each ink and adds no boost', () => {
  applyChatAppearance(html, 90, 'comfortable')
  expect(html.getAttribute('data-chat-width')).toBe('comfortable')
  expect(html.getAttribute('data-chat-contrast')).toBe('lower')
  expect(html.style.getPropertyValue('--chat-contrast-keep')).toBe('90%')
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('0%')
})

test('higher contrast boosts by half the distance past the default', () => {
  applyChatAppearance(html, 160, 'wide')
  expect(html.getAttribute('data-chat-contrast')).toBe('higher')
  expect(html.style.getPropertyValue('--chat-contrast-keep')).toBe('100%')
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('30%')
  applyChatAppearance(html, 100, 'wide')
  expect(html.hasAttribute('data-chat-contrast')).toBe(false)
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('')
})

test('the mounted hook follows the store as the settings change', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  function Themed() {
    useAppTheme()
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Themed />))
  await act(async () => {
    useWorkspaceStore.getState().setAppearanceChatWidth('wide')
    useWorkspaceStore.getState().setAppearanceChatContrast(150)
  })
  expect(html.getAttribute('data-chat-width')).toBe('wide')
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('25%')
  await act(async () => {
    useWorkspaceStore.getState().setAppearanceChatWidth('full')
    useWorkspaceStore.getState().setAppearanceChatContrast(100)
  })
  expect(html.getAttribute('data-chat-width')).toBe('full')
  expect(html.hasAttribute('data-chat-contrast')).toBe(false)
  await act(async () => root.unmount())
})

test('the mounted hook keeps the app clock on the stored Clock setting', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useWorkspaceStore.getState().setAppearanceClockFormat('24h')
  function Themed() {
    useAppTheme()
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Themed />))
  expect(clockFormat()).toBe('24h')
  await act(async () => useWorkspaceStore.getState().setAppearanceClockFormat('12h'))
  expect(clockFormat()).toBe('12h')
  await act(async () => root.unmount())
  useWorkspaceStore.getState().setAppearanceClockFormat('system')
  setClockFormat('system')
})

test('the boot script stamps the persisted chat appearance before the first paint, as the hook would', () => {
  const boot = readFileSync(join(process.cwd(), 'src', 'renderer', 'public', 'boot-theme.js'), 'utf8')
  const stamped = (appearance: Record<string, unknown>) => {
    applyChatAppearance(html, 100, 'full')
    html.removeAttribute('data-chat-width')
    window.localStorage.setItem('sprintengine-app-settings', JSON.stringify({ state: { appSettings: { appearance } } }))
    new Function(boot)()
    return {
      width: html.getAttribute('data-chat-width'),
      contrast: html.getAttribute('data-chat-contrast'),
      keep: html.style.getPropertyValue('--chat-contrast-keep'),
      boost: html.style.getPropertyValue('--chat-contrast-boost'),
    }
  }
  const expected = (contrast: number, width: 'full' | 'wide' | 'comfortable') => {
    applyChatAppearance(html, contrast, width)
    return {
      width: html.getAttribute('data-chat-width'),
      contrast: html.getAttribute('data-chat-contrast'),
      keep: html.style.getPropertyValue('--chat-contrast-keep'),
      boost: html.style.getPropertyValue('--chat-contrast-boost'),
    }
  }
  try {
    expect(stamped({ chatWidth: 'comfortable', chatContrast: 160 })).toEqual(expected(160, 'comfortable'))
    expect(stamped({ chatWidth: 'wide', chatContrast: 87 })).toEqual(expected(85, 'wide'))
    expect(stamped({ chatContrast: 100 })).toEqual(expected(100, 'full'))
    expect(stamped({ chatWidth: 'enormous', chatContrast: 'loud' })).toEqual(expected(100, 'full'))
    // Nothing stored is a new install, which opens on Comfortable, as the
    // store's normaliser reads it; a stored appearance without a width keeps
    // Full (the `chatContrast: 100` case above).
    expect(stamped(undefined as unknown as Record<string, unknown>)).toEqual(expected(100, 'comfortable'))
  } finally {
    window.localStorage.removeItem('sprintengine-app-settings')
  }
})

test('under System, the boot script and the hook paint the theme chosen for the side the OS is on', async () => {
  const boot = readFileSync(join(process.cwd(), 'src', 'renderer', 'public', 'boot-theme.js'), 'utf8')
  const original = window.matchMedia
  let light = true
  window.matchMedia = ((query: string) => ({
    matches: query.includes('light') ? light : !light,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
  const booted = (appearance: Record<string, unknown>) => {
    window.localStorage.setItem('sprintengine-app-settings', JSON.stringify({ state: { appSettings: { appearance } } }))
    new Function(boot)()
    return [html.getAttribute('data-theme'), html.getAttribute('data-mode')]
  }
  try {
    expect(booted({ theme: 'system' })).toEqual(['light', 'light'])
    expect(booted({ theme: 'system', systemLightTheme: 'paper', systemDarkTheme: 'nord' })).toEqual(['paper', 'light'])
    light = false
    expect(booted({ theme: 'system', systemLightTheme: 'paper', systemDarkTheme: 'nord' })).toEqual(['nord', 'dark'])
    expect(booted({ theme: 'system' })).toEqual(['dark', 'dark'])

    const container = document.createElement('div')
    const root = createRoot(container)
    function Probe() {
      useAppTheme({ mirrorToMain: false })
      return null
    }
    useWorkspaceStore.getState().setAppearanceTheme('system')
    useWorkspaceStore.getState().setAppearanceSystemTheme('dark', 'dracula')
    await act(async () => root.render(<Probe />))
    expect(html.getAttribute('data-theme')).toBe('dracula')
    await act(async () => useWorkspaceStore.getState().setAppearanceSystemTheme('dark', 'tokyo-night'))
    expect(html.getAttribute('data-theme')).toBe('tokyo-night')
    // A light theme is not a choice for dark mode: the store keeps that side's default.
    await act(async () => useWorkspaceStore.getState().setAppearanceSystemTheme('dark', 'paper'))
    expect(useWorkspaceStore.getState().appSettings.appearance.systemDarkTheme).toBe('dark')
    act(() => root.unmount())
  } finally {
    window.matchMedia = original
    window.localStorage.removeItem('sprintengine-app-settings')
    useWorkspaceStore.getState().setAppearanceSystemTheme('dark', 'dark')
  }
})
