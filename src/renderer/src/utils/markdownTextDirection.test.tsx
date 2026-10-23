import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CodeBlock } from '../components/ui/CodeBlock'
import { renderMarkdown } from './markdown'

// A reply as the conversation draws it, and a message as a person typed it.
function reply(markdown: string): string {
  return renderToStaticMarkup(renderMarkdown(markdown, { density: 'chat', repairFileLinks: true, math: true }))
}

function message(markdown: string): string {
  return renderToStaticMarkup(renderMarkdown(markdown, { density: 'chat', userText: true }))
}

// The opening tag of the first element named `tag`.
function openingTag(html: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'u').exec(html)?.[0] ?? ''
}

test('an Arabic paragraph reads right to left, and its inline code is isolated left to right', () => {
  const html = reply('استخدم `useEffect` داخل المكوّن هنا')
  expect(openingTag(html, 'p')).toContain('dir="rtl"')
  expect(openingTag(html, 'code')).toContain('dir="ltr"')
})

test('an Arabic line that opens on an English term still reads right to left', () => {
  expect(openingTag(reply('StrictMode: يعيد الـ render مرتين في التطوير'), 'p')).toContain('dir="rtl"')
})

test('inline code does not vote: Arabic around three identifiers reads right to left', () => {
  expect(openingTag(reply('`useEffect` و `useLayoutEffect` في `React`'), 'p')).toContain('dir="rtl"')
})

test('a heading, a quote and a table take their own direction', () => {
  expect(openingTag(reply('## خطوات الإعداد'), 'h2')).toContain('dir="rtl"')
  expect(openingTag(reply('> هذا اقتباس من التوثيق'), 'blockquote')).toContain('dir="rtl"')
  expect(openingTag(reply('> [!NOTE]\n> لاحظ هذا جيدا'), 'div role="note"')).toContain('dir="rtl"')
  const table = reply('| الاسم | القيمة |\n| --- | --- |\n| المهلة | ثلاثون ثانية |')
  expect(openingTag(table, 'table')).toContain('dir="rtl"')
})

test('a list takes one direction from all of its items, and its items follow it', () => {
  const html = reply('- Vitest\n- اختبر الدالة الجديدة\n- وأضف تعليقا')
  expect(openingTag(html, 'ul')).toContain('dir="rtl"')
  expect(html).not.toMatch(/<li[^>]*dir=/u)
  expect(openingTag(reply('1. افتح الملف\n2. احفظه'), 'ol')).toContain('dir="rtl"')
})

test('code stays left to right, inside an Arabic list item too', () => {
  const html = reply('- اكتب الدالة:\n\n  ```ts\n  // احسب مجموع القيم هنا\n  const total = 0\n  ```')
  expect(openingTag(html, 'ul')).toContain('dir="rtl"')
  expect(openingTag(html, 'pre')).toContain('dir="ltr"')
  expect(reply('```\n// احسب مجموع القيم هنا\n```')).not.toContain('dir="rtl"')
})

test("a conversation's code block frame is left to right, inside an Arabic list item too", () => {
  const html = renderToStaticMarkup(
    renderMarkdown('- اكتب الدالة:\n\n  ```ts\n  const total = 0\n  ```', { density: 'chat', codeBlock: CodeBlock }),
  )
  expect(openingTag(html, 'ul')).toContain('dir="rtl"')
  expect(openingTag(html, 'section')).toContain('dir="ltr"')
})

test('a message a person typed reads in its own direction', () => {
  const html = message('مرحبا، هل يمكنك إصلاح `fetch()` هنا؟\nشكرا')
  expect(openingTag(html, 'p')).toContain('dir="rtl"')
  expect(openingTag(html, 'code')).toContain('dir="ltr"')
})

test('an English document keeps exactly the markup it had: no direction on prose or inline code', () => {
  const html = reply(
    [
      '# Setup',
      'Run `npm ci`, then **build** with the [guide](https://example.com).',
      '- one\n- two',
      '1. first\n2. second',
      '> a quote',
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      'English quoting one Arabic word: مرحبا',
    ].join('\n\n'),
  )
  expect(html).not.toContain('dir=')
})

test('only right-to-left blocks are marked, so a mixed reply leaves its English blocks alone', () => {
  const html = reply('First the English line.\n\nثم السطر العربي هنا')
  const paragraphs = html.match(/<p[^>]*>/gu) ?? []
  expect(paragraphs).toHaveLength(2)
  expect(paragraphs[0]).not.toContain('dir=')
  expect(paragraphs[1]).toContain('dir="rtl"')
})
