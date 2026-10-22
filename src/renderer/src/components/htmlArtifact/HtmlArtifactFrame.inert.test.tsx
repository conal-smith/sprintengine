// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { INERT_HTML_POLICY, inertHtml } from '../../utils/inertHtml'
import { HtmlPreviewCard } from '../ui/HtmlPreviewCard'
import { HtmlArtifactFrame } from './HtmlArtifactFrame'

// A generated page shown with its scripts off loads nothing from elsewhere;
// one the person turned scripts on for runs as written.

const PAGE = '<!doctype html><html><body><img src="https://images.example.test/pixel.png"></body></html>'

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {
    pathExists: async () => true,
    readfile: async () => PAGE,
    watchPath: async () => async () => {},
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(element))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return host
}

const srcdoc = () => host!.querySelector('iframe')!.getAttribute('srcdoc') ?? ''

test('the policy goes after the doctype, so the page keeps its rendering mode', () => {
  expect(inertHtml(PAGE).startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
  expect(inertHtml('<p>hi</p>')).toBe(
    `<meta http-equiv="Content-Security-Policy" content="${INERT_HTML_POLICY}"><p>hi</p>`,
  )
  expect(INERT_HTML_POLICY).toContain("default-src 'none'")
})

test('the full preview with scripts off refuses loads from elsewhere, and with scripts on runs as written', async () => {
  await mount(
    <HtmlArtifactFrame
      absolutePath="/Users/dev/app/a.html"
      relativePath="a.html"
      watchDirectoryPath="/Users/dev/app"
    />,
  )
  expect(srcdoc()).toContain(`content="${INERT_HTML_POLICY}"`)
  const toggle = [...host!.querySelectorAll('button')].find((button) =>
    /interactive demo/i.test(button.textContent ?? ''),
  )!
  await act(async () => toggle.click())
  expect(srcdoc()).toBe(PAGE)
})

test('the gallery thumbnail refuses loads from elsewhere', async () => {
  await mount(
    <HtmlPreviewCard absolutePath="/Users/dev/app/a.html" relativePath="a.html" title="A" onOpen={() => {}} />,
  )
  expect(srcdoc()).toContain(`content="${INERT_HTML_POLICY}"`)
})
