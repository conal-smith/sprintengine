// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { SEALED_VISUAL_URL_PREFIX } from '../../../../shared/sealed-visual'
import { buildScriptedVisualDocument, hasVisualScript, SEALED_VISUAL_POLICY } from './scriptedVisualDocument'
import { MAX_VISUAL_SOURCE, VISUAL_EMPTY, VISUAL_TOO_LARGE, type VisualTheme } from './visualDocument'

const theme: VisualTheme = { variables: { '--fg': 'rgb(50, 60, 70)', '--chart-1': 'rgb(7, 126, 240)' } }

function build(source: string) {
  const result = buildScriptedVisualDocument(source, theme)
  if ('error' in result) throw new Error(`refused: ${result.error}`)
  return { ...result, doc: new DOMParser().parseFromString(result.html, 'text/html') }
}

const sortable = `<h3>Open bugs by team</h3>
<table id="t"><tr><th>Team</th><th>Open</th></tr><tr><td>Web</td><td>12</td></tr></table>
<script>document.getElementById('t').addEventListener('click', () => {})</script>`

test('only a block with a script element takes the sealed road', () => {
  expect(hasVisualScript(sortable)).toBe(true)
  expect(hasVisualScript('<SCRIPT src="x"></SCRIPT>')).toBe(true)
  expect(hasVisualScript('<svg><rect fill="var(--chart-1)"/></svg>')).toBe(false)
  // Prose about scripts, or a handler with no script element, stays static.
  expect(hasVisualScript('<p>&lt;script&gt; is not allowed</p><p onclick="x()">x</p>')).toBe(false)
  expect(hasVisualScript('<p>a <scripture> reading</p>')).toBe(false)
})

test('the policy refuses every load and allows only inline script and style', () => {
  expect(SEALED_VISUAL_POLICY).toBe(
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'",
  )
  expect(SEALED_VISUAL_POLICY).not.toMatch(/https?:|connect-src|frame-src|unsafe-eval|blob:|\*/)
})

test('the document opens with the policy, then the reporter, then the visual in order', () => {
  const { doc, title, url, html } = build(sortable)
  const first = doc.head.firstElementChild
  expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  expect(first?.getAttribute('content')).toBe(SEALED_VISUAL_POLICY)
  const scripts = [...doc.querySelectorAll('script')]
  expect(scripts).toHaveLength(2)
  expect(scripts[0].parentElement).toBe(doc.head)
  expect(scripts[0].textContent).toContain("type: 'height'")
  expect(scripts[1].textContent).toContain("getElementById('t')")
  expect(doc.querySelector('table td')?.textContent).toBe('Web')
  // Coloured with the theme of the draw it was built in.
  expect(doc.head.querySelector('style')?.textContent).toContain('--chart-1: rgb(7, 126, 240);')
  expect(title).toBe('Open bugs by team')
  expect(url.startsWith(SEALED_VISUAL_URL_PREFIX)).toBe(true)
  expect(decodeURIComponent(url.slice(SEALED_VISUAL_URL_PREFIX.length))).toBe(html)
})

test('elements that load, frame, refresh or re-base a document are taken out', () => {
  const { doc } = build(`<html><head>
<meta http-equiv="refresh" content="0;url=https://example.com/">
<base href="https://example.com/"><link rel="stylesheet" href="https://example.com/a.css">
<style>.x { color: var(--fg) }</style><script>window.ready = true</script></head>
<body><p class="x">Hi</p><iframe src="https://example.com/"></iframe><object data="x"></object>
<embed src="x"><button>Toggle</button><script>window.later = 1</script></body></html>`)
  // Only the policy's own meta is left.
  expect([...doc.querySelectorAll('meta')].map((meta) => meta.getAttribute('http-equiv'))).toEqual([
    'Content-Security-Policy',
  ])
  expect(doc.querySelectorAll('base, link, iframe, object, embed')).toHaveLength(0)
  // Its own styles, scripts and controls stay.
  expect(doc.head.textContent).toContain('.x { color: var(--fg) }')
  expect(doc.head.textContent).toContain('window.ready = true')
  expect(doc.body.querySelector('button')?.textContent).toBe('Toggle')
  expect(doc.body.textContent).toContain('window.later = 1')
})

test('one size limit, and a block with nothing to draw or run, are refused', () => {
  const large = `<script></script><p>${'x'.repeat(MAX_VISUAL_SOURCE)}</p>`
  expect(buildScriptedVisualDocument(large, theme)).toEqual({ error: VISUAL_TOO_LARGE })
  expect(buildScriptedVisualDocument('<meta http-equiv="refresh" content="0">', theme)).toEqual({
    error: VISUAL_EMPTY,
  })
  // A script that builds everything itself has something to run.
  expect('error' in buildScriptedVisualDocument('<div id="r"></div><script>r.textContent = 1</script>', theme)).toBe(
    false,
  )
})
