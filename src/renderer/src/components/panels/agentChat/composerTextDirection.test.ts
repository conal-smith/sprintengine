import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'
import { composerLineDirections } from './composerTextDirection'

// One entry per line: its direction, or '-' for a code line or one no
// letters have reached yet.
function directions(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] })
  return composerLineDirections(state).map((direction) => direction ?? '-')
}

test('an Arabic line reads right to left and an English one left to right', () => {
  expect(directions('اكتب دالة تجمع الأرقام\nfix the failing test')).toEqual(['rtl', 'ltr'])
})

test('inline code does not count toward a line, nor does a link address', () => {
  expect(directions('`useEffect` و `useLayoutEffect` في `React`')).toEqual(['rtl'])
  expect(directions('اقرأ [الدليل](https://example.com/getting-started/guide) أولا')).toEqual(['rtl'])
})

test('a list takes one direction from all of its items', () => {
  expect(directions('- Vitest\n- اختبر الدالة الجديدة\n- وأضف تعليقا')).toEqual(['rtl', 'rtl', 'rtl'])
  expect(directions('> سطر أول\n> second line')).toEqual(['rtl', 'rtl'])
})

test('a line with no letters yet continues the line above it', () => {
  expect(directions('اكتب الدالة\n\n42\nfix it')).toEqual(['rtl', 'rtl', 'rtl', 'ltr'])
  expect(directions('fix it\n\nاكتب الدالة\n42')).toEqual(['ltr', 'ltr', 'rtl', 'rtl'])
  expect(directions('42')).toEqual(['-'])
})

test('a code block stays left to right inside Arabic text, and a line after it continues the text', () => {
  expect(directions('اكتب الدالة\n```\n// احسب مجموع القيم هنا\n\n```\n\nثم اختبرها')).toEqual([
    'rtl',
    '-',
    '-',
    '-',
    '-',
    'rtl',
    'rtl',
  ])
})

test('an English draft has no right-to-left line', () => {
  expect(directions('# Plan\n- one\n- two\n> quote\n\n```\ncode\n```\nrun `npm ci`')).toEqual([
    'ltr',
    'ltr',
    'ltr',
    'ltr',
    'ltr',
    '-',
    '-',
    '-',
    'ltr',
  ])
})

test('the composer marks a right-to-left line and isolates its inline code left to right', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { ComposerField } = await import('./ComposerField')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(ComposerField, { value: 'اكتب `sumBy` تجمع القيم\nfix the test', onChange: () => undefined }),
      ),
    )
    const lines = [...host.querySelectorAll<HTMLElement>('.cm-line')]
    expect(lines.map((line) => line.getAttribute('dir'))).toEqual(['rtl', null])
    const isolate = lines[0].querySelector('[dir="ltr"]')
    expect(isolate?.textContent).toContain('sumBy')
    expect(lines[1].querySelector('[dir]')).toBeNull()
    await act(async () => root.unmount())
  } finally {
    for (const key of Object.keys(Object.getOwnPropertyDescriptors(globalThis))) {
      if (!(key in previous)) delete (globalThis as Record<string, unknown>)[key]
    }
    Object.defineProperties(globalThis, previous)
    dom.window.close()
  }
})
