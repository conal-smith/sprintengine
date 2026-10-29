// @vitest-environment jsdom
import DOMPurify from 'dompurify'
import { expect, test } from 'vitest'
import { INERT_HTML_POLICY } from '../../utils/inertHtml'
import {
  buildVisualDocument,
  MAX_VISUAL_SOURCE,
  VISUAL_EMPTY,
  VISUAL_TOO_LARGE,
  type VisualTheme,
} from './visualDocument'

const theme: VisualTheme = {
  variables: {
    '--fg': 'rgb(50, 60, 70)',
    '--fg-muted': 'rgb(100, 110, 120)',
    '--border': 'rgba(32, 36, 40, 0.2)',
    '--chart-1': 'rgb(7, 126, 240)',
    '--chart-2': 'rgb(234, 99, 12)',
    '--font': 'Inter, "SF Pro Text", sans-serif',
  },
}

function build(source: string): { html: string; title: string; doc: Document } {
  const result = buildVisualDocument(DOMPurify, source, theme)
  if ('error' in result) throw new Error(`refused: ${result.error}`)
  return { ...result, doc: new DOMParser().parseFromString(result.html, 'text/html') }
}

// What an analytics answer draws: a titled line chart with a shaded band, axis
// labels and a caption, then a horizontal stacked-bar comparison with
// labelled segments, then a compact table.
const ANALYTICS_ANSWER = `
<style>
  .caption { color: var(--fg-muted); font-size: var(--font-size-small); }
  .grid line { stroke: var(--border); }
</style>
<h3>Weekly active users</h3>
<svg width="100%" height="220" viewBox="0 0 600 220" role="img" aria-label="Weekly active users, rising">
  <defs>
    <linearGradient id="band" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--chart-1)" stop-opacity="0.25"/>
      <stop offset="1" stop-color="var(--chart-1)" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="grid">
    <line x1="40" x2="590" y1="40" y2="40" stroke-dasharray="2 4"/>
    <line x1="40" x2="590" y1="180" y2="180"/>
  </g>
  <path d="M40,150 L150,130 L260,120 L370,90 L480,70 L590,50 L590,90 L480,110 L370,125 L260,150 L150,160 L40,175 Z" fill="url(#band)"/>
  <polyline points="40,160 150,145 260,135 370,108 480,90 590,70" fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="590" cy="70" r="3" fill="var(--chart-1)"/>
  <text x="36" y="44" text-anchor="end" font-size="11" fill="var(--fg-muted)">12k</text>
  <text x="36" y="184" text-anchor="end" dominant-baseline="middle" fill="var(--fg-muted)">0</text>
  <text x="315" y="210" text-anchor="middle" fill="var(--fg-muted)">Week</text>
  <text transform="rotate(-90 12 110)" x="12" y="110" text-anchor="middle">Users</text>
</svg>
<p class="caption">Shaded band: 80% interval. Growth held through the release in week 4.</p>
<svg width="100%" height="64" viewBox="0 0 600 64">
  <g transform="translate(80 8)">
    <rect x="0" y="0" width="300" height="20" rx="2" fill="var(--chart-1)"/>
    <rect x="300" y="0" width="120" height="20" fill="var(--chart-2)"/>
    <text x="150" y="14" text-anchor="middle" fill="white" font-weight="600">Desktop 60%</text>
    <text x="360" y="14" text-anchor="middle">Web 24%</text>
  </g>
  <text x="72" y="22" text-anchor="end">Team A</text>
  <use href="#band"/>
</svg>
<table><thead><tr><th>Segment</th><th>Share</th></tr></thead><tbody><tr><td>Desktop</td><td>60%</td></tr></tbody></table>
`

test('a chart keeps its SVG whole: shapes, text, gradients and every presentation attribute', () => {
  const { doc, title } = build(ANALYTICS_ANSWER)
  const svgs = doc.querySelectorAll('svg')
  expect(svgs).toHaveLength(2)
  expect(svgs[0].getAttribute('viewBox')).toBe('0 0 600 220')
  expect(svgs[0].getAttribute('height')).toBe('220')
  for (const tag of [
    'path',
    'polyline',
    'line',
    'rect',
    'text',
    'g',
    'circle',
    'linearGradient',
    'stop',
    'defs',
    'use',
  ])
    expect(doc.getElementsByTagName(tag).length, tag).toBeGreaterThan(0)
  const line = doc.querySelector('polyline')
  expect(line?.getAttribute('stroke')).toBe('var(--chart-1)')
  expect(line?.getAttribute('stroke-linejoin')).toBe('round')
  expect(line?.getAttribute('points')).toBe('40,160 150,145 260,135 370,108 480,90 590,70')
  // The band is filled from its own gradient, which is not a fetch.
  expect(doc.querySelector('path')?.getAttribute('fill')).toBe('url(#band)')
  expect(doc.querySelector('.grid line')?.getAttribute('stroke-dasharray')).toBe('2 4')
  const labels = [...doc.querySelectorAll('text')]
  expect(labels.map((label) => label.textContent)).toContain('Desktop 60%')
  expect(labels[0].getAttribute('text-anchor')).toBe('end')
  expect(labels[1].getAttribute('dominant-baseline')).toBe('middle')
  expect(labels.find((label) => label.textContent === 'Users')?.getAttribute('transform')).toBe('rotate(-90 12 110)')
  expect(doc.querySelector('stop')?.getAttribute('stop-opacity')).toBe('0.25')
  expect(doc.querySelector('use')?.getAttribute('href')).toBe('#band')
  expect(doc.querySelector('g[transform="translate(80 8)"] rect')?.getAttribute('rx')).toBe('2')
  // The visual's own stylesheet, its caption and its table.
  expect([...doc.querySelectorAll('style')].some((style) => style.textContent?.includes('.caption'))).toBe(true)
  expect(doc.querySelector('.caption')?.textContent).toContain('80% interval')
  expect(doc.querySelector('table td')?.textContent).toBe('Desktop')
  expect(title).toBe('Weekly active users')
})

test('the document carries the inert policy before anything else', () => {
  const { html, doc } = build('<p>Hi</p>')
  expect(html.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
  expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toBe(
    INERT_HTML_POLICY,
  )
})

test('scripts, handlers, frames, forms and stylesheet links are taken out', () => {
  const { html, doc } = build(`
    <script>parent.alert(1)</script>
    <svg onload="alert(1)" height="10"><script>alert(2)</script><rect onclick="alert(3)" width="5" height="5"/></svg>
    <img src="x" onerror="alert(4)">
    <iframe src="https://example.com"></iframe><object data="x"></object><embed src="x">
    <form action="https://example.com"><input name="q"><button>Go</button></form>
    <link rel="stylesheet" href="https://example.com/a.css"><meta http-equiv="refresh" content="0;url=https://example.com">
    <p>kept</p>`)
  expect(doc.querySelectorAll('script, iframe, object, embed, form, input, button, link')).toHaveLength(0)
  expect(html).not.toMatch(/on(load|click|error)=/u)
  expect(html).not.toContain('example.com')
  // The one meta left is the policy.
  expect(doc.querySelectorAll('meta')).toHaveLength(1)
  expect(doc.querySelector('rect')).not.toBeNull()
  expect(doc.body.textContent).toContain('kept')
})

test('links keep their text and lose their address; only inline pictures and own fragments stay', () => {
  const { doc } = build(`
    <a href="javascript:alert(1)">one</a> <a href="https://example.com">two</a>
    <svg height="10"><a href="https://example.com"><text>three</text></a><a xlink:href="javascript:alert(1)"><text>four</text></a>
      <image href="https://example.com/p.png" width="5" height="5"/><image href="data:image/png;base64,AAAA" width="5" height="5"/>
      <use href="data:image/svg+xml;base64,AAAA"/><use href="https://example.com/s.svg#x"/></svg>
    <img src="https://example.com/p.png"><img src="data:image/png;base64,AAAA">`)
  for (const link of doc.querySelectorAll('a')) {
    expect(link.hasAttribute('href')).toBe(false)
    expect(link.hasAttribute('xlink:href')).toBe(false)
  }
  expect(doc.body.textContent).toMatch(/one[\s\S]*two[\s\S]*three[\s\S]*four/u)
  const images = [...doc.querySelectorAll('image')].map((image) => image.getAttribute('href'))
  expect(images).toEqual([null, 'data:image/png;base64,AAAA'])
  // A `<use>` points only at the visual's own elements.
  expect([...doc.querySelectorAll('use')].map((use) => use.getAttribute('href'))).toEqual([null, null])
  const pictures = [...doc.querySelectorAll('img')].map((image) => image.getAttribute('src'))
  expect(pictures).toEqual([null, 'data:image/png;base64,AAAA'])
})

test('CSS that would fetch is made inert, in stylesheets and attributes alike', () => {
  const { html } = build(`
    <style>@import url("https://example.com/a.css"); body { background: url(https://example.com/bg.png) }
      @font-face { font-family: X; src: url(https://example.com/x.woff2) } .x { background-image: u\\72l(https://example.com/y.png) }</style>
    <div style="background: url('https://example.com/z.png')">x</div>
    <svg height="10"><rect width="5" height="5" fill="url(https://example.com/f.svg#p)"/><rect width="5" height="5" fill="url(#own)"/></svg>`)
  expect(html).not.toContain('example.com')
  expect(html).not.toContain('@import')
  expect(html).toContain('url(#own)')
})

test('a whole document is taken: its head stylesheets kept, the rest of the head dropped', () => {
  const { doc, title } = build(`<!doctype html><html><head><title>Latency by region</title>
    <style>.bar { fill: var(--chart-2) }</style><base href="https://example.com/"></head>
    <body style="background:#000"><svg height="10"><rect class="bar" width="5" height="5"/></svg></body></html>`)
  expect(title).toBe('Latency by region')
  expect(doc.querySelector('base')).toBeNull()
  expect([...doc.head.querySelectorAll('style')].some((style) => style.textContent?.includes('.bar'))).toBe(true)
  expect(doc.querySelector('rect.bar')).not.toBeNull()
  // The page background the agent set is not carried over.
  expect(doc.body.getAttribute('style')).toBeNull()
})

test("the theme's variables open the document, with the base stylesheet", () => {
  const { doc } = build('<p>Hi</p>')
  const base = doc.head.querySelector('style')?.textContent ?? ''
  expect(base).toContain('--chart-1: rgb(7, 126, 240);')
  expect(base).toContain('--chart-2: rgb(234, 99, 12);')
  expect(base).toContain('--fg: rgb(50, 60, 70);')
  expect(base).toContain('--font: Inter, "SF Pro Text", sans-serif;')
  expect(base).toMatch(/background: transparent/u)
  expect(base).toMatch(/color: var\(--fg\)/u)
  // Unfilled SVG text takes the ink rather than black.
  expect(base).toContain('svg:not([fill]) { fill: currentColor; }')
  expect(base).not.toContain('color-scheme')

  const dark = buildVisualDocument(DOMPurify, '<p>Hi</p>', { variables: { '--fg': 'white' }, colorScheme: 'dark' })
  expect('html' in dark && dark.html).toContain('color-scheme: dark;')
  // A value that could close the rule is never written.
  const hostile = buildVisualDocument(DOMPurify, '<p>Hi</p>', { variables: { '--fg': 'red; } body { x: y' } })
  expect('html' in hostile && hostile.html).not.toContain('body { x: y')
})

test('a source too large, or with nothing left to draw, is refused', () => {
  expect(buildVisualDocument(DOMPurify, `<p>${'x'.repeat(MAX_VISUAL_SOURCE)}</p>`, theme)).toEqual({
    error: VISUAL_TOO_LARGE,
  })
  expect(buildVisualDocument(DOMPurify, '<script>alert(1)</script>', theme)).toEqual({ error: VISUAL_EMPTY })
  expect(buildVisualDocument(DOMPurify, '   ', theme)).toEqual({ error: VISUAL_EMPTY })
  // A drawing with no words is still something to draw.
  expect('html' in buildVisualDocument(DOMPurify, '<svg height="4"><rect width="4" height="4"/></svg>', theme)).toBe(
    true,
  )
})
