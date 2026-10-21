import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { renderMarkdown } from './markdown'
import { PASTE_STYLES } from './pasteStyles'
import { copySelectionAsMarkdown, renderedMarkdown, selectionClipboard } from './selectionToMarkdown'

// A code block as the HTML flavour writes it: no language class, which means
// nothing to the editor it lands in, and the shared paste styles.
const pastedCode = (code: string) =>
  `<pre style="${PASTE_STYLES.pre}"><code style="${PASTE_STYLES.codeBlock}">${code}</code></pre>`

// A conversation log in a real DOM: the serializer reads live ranges and
// clones, so the tests select text the way a person's drag does.
function page(html: string) {
  const { window } = new JSDOM(`<!doctype html><body><div id="log">${html}</div><p id="outside">Elsewhere</p></body>`)
  const document = window.document
  const log = document.getElementById('log')!
  const selection = window.getSelection()!
  const select = (range: Range) => {
    selection.removeAllRanges()
    selection.addRange(range)
  }
  // The text node holding `needle`, and the offset where it starts.
  const at = (needle: string, root: Node = document.body): [Text, number] => {
    const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(needle) ?? -1
      if (index >= 0) return [node as Text, index]
    }
    throw new Error(`no text “${needle}”`)
  }
  return {
    window,
    document,
    log,
    selection,
    /** Everything inside the log. */
    selectAll() {
      const range = document.createRange()
      range.selectNodeContents(log)
      select(range)
    },
    /** From the start of `from` to the end of `to`, as a drag would. */
    selectBetween(from: string, to: string) {
      const [startNode, startOffset] = at(from)
      const [endNode, endOffset] = at(to)
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset + to.length)
      select(range)
    },
    copy() {
      return selectionClipboard(selection, log)
    },
  }
}

const markdownOf = (html: string) => {
  const view = page(html)
  view.selectAll()
  return view.copy()?.text
}

test('headings keep their level', () => {
  expect(markdownOf('<h1>Plan</h1><h3>Step <em>one</em></h3><p>Body</p>')).toBe('# Plan\n\n### Step *one*\n\nBody')
})

test('bold, italic and strikethrough are written back, with the spaces outside the markers', () => {
  expect(markdownOf('<p>Run <strong>the tests </strong>and <em>then</em> <del>ship</del> <b>wait</b>.</p>')).toBe(
    'Run **the tests** and *then* ~~ship~~ **wait**.',
  )
})

test('inline code is fenced past any backtick run inside it', () => {
  expect(markdownOf('<p>Use <code>npm test</code>, <code>a`b</code> and <code>`tick`</code>.</p>')).toBe(
    'Use `npm test`, ``a`b`` and `` `tick` ``.',
  )
})

test('links carry their target; a bare URL stays bare and a non-web link stays text', () => {
  expect(
    markdownOf(
      '<p><a href="https://example.com/docs">the docs</a>, <a href="https://example.com">https://example.com</a>, ' +
        '<a href="javascript:alert(1)">bad</a> and <a href="https://example.com/a b">[spaced]</a></p>',
    ),
  ).toBe('[the docs](https://example.com/docs), https://example.com, bad and [\\[spaced\\]](<https://example.com/a b>)')
})

test('unordered, ordered and nested lists keep their markers and indentation', () => {
  expect(
    markdownOf(
      '<ul>\n<li>First\n<ul>\n<li>Inner <code>x</code></li>\n</ul>\n</li>\n<li>Second</li>\n</ul>\n' +
        '<ol start="3">\n<li>Three</li>\n<li>Four\n<ol>\n<li>Four A</li>\n</ol>\n</li>\n</ol>',
    ),
  ).toBe('- First\n  - Inner `x`\n- Second\n\n3. Three\n4. Four\n   1. Four A')
})

test('a loose list keeps a blank line between its items', () => {
  expect(markdownOf('<ul>\n<li>\n<p>One</p>\n<p>More</p>\n</li>\n<li>\n<p>Two</p>\n</li>\n</ul>')).toBe(
    '- One\n\n  More\n\n- Two',
  )
})

test('a task list writes its boxes as [x] and [ ]', () => {
  expect(
    markdownOf(
      '<ul class="contains-task-list"><li><span><input type="checkbox" checked readonly>' +
        '<span aria-hidden="true"><svg></svg></span></span>Done</li>' +
        '<li><input type="checkbox">Not yet</li></ul>',
    ),
  ).toBe('- [x] Done\n- [ ] Not yet')
})

test('a blockquote is quoted line by line, blank lines included', () => {
  expect(markdownOf('<blockquote>\n<p>First <strong>point</strong></p>\n<p>Second</p>\n</blockquote>')).toBe(
    '> First **point**\n>\n> Second',
  )
})

test('an alert is quoted under its kind, without its drawn title', () => {
  expect(markdownOf('<div role="note" data-alert="warning"><p><svg></svg>Warning</p><p>Back up first.</p></div>')).toBe(
    '> [!WARNING]\n> Back up first.',
  )
})

test('a code block is fenced with the language its root declares, and its header is left out', () => {
  expect(
    markdownOf(
      '<p>Run this:</p><section class="ds-code-block" data-code-language="bash">' +
        '<div class="ds-code-block__header" data-copy-exclude><span>bash</span><button>Copy</button></div>' +
        '<pre><code><span>npm</span> <span>test</span>\n</code></pre></section><p>Then commit.</p>',
    ),
  ).toBe('Run this:\n\n```bash\nnpm test\n```\n\nThen commit.')
})

test('code holding a fence gets a longer one', () => {
  expect(markdownOf('<p>Example:</p><pre><code class="language-md">```js\nx\n```</code></pre>')).toBe(
    'Example:\n\n````md\n```js\nx\n```\n````',
  )
})

test('a code block names its language from a language class when the root does not', () => {
  expect(markdownOf('<p>A</p><pre><code class="language-typescript">const a = 1</code></pre>')).toBe(
    'A\n\n```typescript\nconst a = 1\n```',
  )
})

test('plain-text code blocks get a fence with no language', () => {
  expect(markdownOf('<p>A</p><div data-code-language="text"><pre><code>plain</code></pre></div>')).toBe(
    'A\n\n```\nplain\n```',
  )
})

test('a table keeps its columns, its alignment and its inline formatting, with pipes escaped', () => {
  expect(
    markdownOf(
      '<div><div><table><thead><tr><th align="left">Name</th><th align="center">Kind</th><th align="right">Size</th><th>Note</th></tr></thead>' +
        '<tbody><tr><td><code>a|b</code></td><td><strong>file</strong></td><td>12</td><td>one<br>two</td></tr></tbody></table></div>' +
        '<div data-copy-exclude><button aria-label="Copy table">Copy</button></div></div>',
    ),
  ).toBe('| Name | Kind | Size | Note |\n| :--- | :---: | ---: | --- |\n| `a\\|b` | **file** | 12 | one two |')
})

test('a selection entirely inside one code block copies the bare code', () => {
  const view = page(
    '<section data-code-language="ts"><div data-copy-exclude>ts</div>' +
      '<pre><code><span>const</span> <span>a</span> = 1\n<span>const</span> b = 2</code></pre></section>',
  )
  view.selectBetween('a', 'b = 2')
  expect(view.copy()?.text).toBe('a = 1\nconst b = 2')
})

test('a selection inside one text node copies exactly that text', () => {
  const view = page('<p>Some <strong>very important</strong> words</p>')
  view.selectBetween('very', 'important')
  expect(view.copy()?.text).toBe('very important')
})

test('a drag that runs onto a whole code block and nothing else copies bare code', () => {
  const view = page('<p>Intro</p>\n<pre><code class="language-sh">make build\n</code></pre>\n<p>Outro</p>')
  const range = view.document.createRange()
  range.setStartAfter(view.log.querySelector('p')!)
  range.setEndBefore(view.log.querySelectorAll('p')[1])
  view.selection.removeAllRanges()
  view.selection.addRange(range)
  expect(view.copy()?.text).toBe('make build')
})

test('part of an ordered list copies as a list that numbers from where it started', () => {
  const view = page('<ol start="2"><li>Alpha one</li><li>Beta two</li><li>Gamma three</li><li>Delta</li></ol>')
  view.selectBetween('two', 'Gamma')
  expect(view.copy()?.text).toBe('3. two\n4. Gamma')
})

test('part of one list item copies as its text, with no marker', () => {
  const view = page('<ul><li>Keep <em>this</em> item</li></ul>')
  view.selectBetween('Keep', 'item')
  expect(view.copy()?.text).toBe('Keep *this* item')
})

test('cells across rows copy as a table of what was selected', () => {
  const view = page(
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></tbody></table>',
  )
  view.selectBetween('b1', 'a2')
  expect(view.copy()?.text).toBe('| b1 |\n| --- |\n| a2 |')
})

test('chrome is left out; a file path set as a button inside prose is kept', () => {
  expect(
    markdownOf(
      '<div><h3 class="sr-only select-none">You said</h3><p>Open <button aria-label="Open src/a.ts">src/a.ts</button> now' +
        '<span class="sr-only"> — link</span><span aria-hidden="true">•</span><svg><text>x</text></svg></p>' +
        '<div><time datetime="2026-09-28">10:42</time><button aria-label="Copy message">Copy</button>' +
        '<span data-copy-exclude>Retry</span><input value="typed"></div></div>',
    ),
  ).toBe('Open src/a.ts now')
})

test('part of a sentence keeps the file path set inside it', () => {
  const view = page('<p>Open <button aria-label="Open src/a.ts">src/a.ts</button> and <em>read</em> it</p>')
  view.selectBetween('Open', 'read')
  expect(view.copy()?.text).toBe('Open src/a.ts and *read*')
})

test('a message action wrapped in a tooltip is chrome, not prose', () => {
  expect(
    markdownOf(
      '<p>Reply</p><div><span class="relative inline-flex"><button>Revert to before this turn</button></span></div>',
    ),
  ).toBe('Reply')
})

test('a user bubble and the reply after it copy as plain paragraphs', () => {
  expect(
    markdownOf(
      '<div class="flex flex-col items-end"><h3 class="sr-only">You said</h3><div class="bubble"><p>Why does it fail?<br>Only on CI.</p></div>' +
        '<div><time>10:41</time></div></div><div><h3 class="sr-only">Assistant said</h3><p>The cache is <strong>stale</strong>.</p></div>',
    ),
  ).toBe('Why does it fail?\nOnly on CI.\n\nThe cache is **stale**.')
})

test('rules and web images are written back; a local image keeps its alt text', () => {
  expect(
    markdownOf(
      '<p>Above</p><hr><p><img src="https://example.com/a.png" alt="Chart"> <img src="blob:x" alt="Shot"></p>',
    ),
  ).toBe('Above\n\n---\n\n![Chart](https://example.com/a.png) Shot')
})

test('the HTML flavour is the fragment with chrome, attributes and handlers stripped, and the paste styles on', () => {
  const view = page(
    '<p class="text-body" style="color:red" onclick="steal()">Hi <a href="https://example.com" class="link" onmouseover="x()">there</a>' +
      ' <button aria-label="Open a.ts" class="link">a.ts</button><svg></svg><span class="sr-only">hidden</span></p>' +
      '<section class="ds-code-block" data-code-language="py"><div data-copy-exclude><button>Copy</button></div>' +
      '<pre><code><span style="color:#fff">print(1)</span></code></pre></section>' +
      '<ul><li><input type="checkbox" checked class="peer">Done</li></ul>' +
      '<div><button aria-label="Copy message">Copy</button></div>',
  )
  view.selectAll()
  const html = view.copy()!.html
  expect(html.startsWith('<meta charset="utf-8">')).toBe(true)
  expect(html).toContain('<p>Hi <a href="https://example.com">there</a> a.ts</p>')
  expect(html).toContain(pastedCode('print(1)'))
  expect(html).toContain('<li>\u2611 Done</li>')
  expect(html).not.toMatch(/<button|<svg|class=|color:|onclick|onmouseover|hidden|Copy/u)
})

test('a selection that reaches outside the container is left to the browser', () => {
  const view = page('<p>Inside</p>')
  view.selectBetween('Inside', 'Elsewhere')
  expect(view.copy()).toBeNull()
})

test('a range inside a block’s chrome is left to the browser', () => {
  const view = page('<div data-copy-exclude><span>bash</span> <span>label</span></div>')
  view.selectBetween('bash', 'label')
  expect(view.copy()).toBeNull()
})

test('the copy event takes both flavours and keeps the browser’s own copy from running', () => {
  const view = page('<h2>Title</h2><p>Body</p>')
  view.selectAll()
  const written: Record<string, string> = {}
  let prevented = false
  const took = copySelectionAsMarkdown(
    {
      target: view.log.querySelector('p'),
      clipboardData: { setData: (type: string, value: string) => void (written[type] = value) },
      preventDefault: () => void (prevented = true),
    },
    view.log,
  )
  expect(took).toBe(true)
  expect(prevented).toBe(true)
  expect(written['text/plain']).toBe('## Title\n\nBody')
  expect(written['text/html']).toBe('<meta charset="utf-8"><h2>Title</h2><p>Body</p>')
})

test('a copy from a field inside the container is left to the field', () => {
  const view = page('<p>Body</p><textarea>draft</textarea>')
  view.selectAll()
  let prevented = false
  const took = copySelectionAsMarkdown(
    {
      target: view.log.querySelector('textarea'),
      clipboardData: { setData: () => undefined },
      preventDefault: () => void (prevented = true),
    },
    view.log,
  )
  expect(took).toBe(false)
  expect(prevented).toBe(false)
})

test('the renderer’s own markdown survives a round trip through the page', () => {
  const source = [
    '## Summary',
    '',
    'The **build** uses `vite` and *two* ~~old~~ steps; see [the guide](https://example.com/guide).',
    '',
    '1. Install',
    '2. Build',
    '   - with cache',
    '',
    '- [x] Tests',
    '- [ ] Docs',
    '',
    '> Note this.',
    '',
    '```ts',
    'const a = 1',
    '```',
    '',
    '| Left | Right |',
    '| :--- | ---: |',
    '| a | 1 |',
  ].join('\n')
  const html = renderToStaticMarkup(createElement('div', null, renderMarkdown(source)))
  const view = page(html)
  view.selectAll()
  expect(view.copy()?.text).toBe(source)
})

test('renderedMarkdown reads a detached fragment too', () => {
  const { window } = new JSDOM('<!doctype html><body><div><h4>Only</h4></div></body>')
  expect(renderedMarkdown(window.document.body)).toBe('#### Only')
})

test('a reply rendered by the conversation’s own components copies back as its source', async () => {
  const { ConversationMarkdown } = await import('../components/panels/agentChat/conversationLinks')
  const source = [
    'Run it:',
    '',
    '```bash',
    'npm test',
    '```',
    '',
    '| Step | Time |',
    '| --- | ---: |',
    '| build | 12s |',
  ].join('\n')
  const view = page(renderToStaticMarkup(createElement(ConversationMarkdown, { text: source })))
  view.selectAll()
  const copied = view.copy()
  expect(copied?.text).toBe(source)
  expect(copied?.html).toContain(pastedCode('npm test'))
  expect(copied?.html).toContain(
    `<td align="right" style="border:1px solid #aaaaaa;padding:4px 8px;text-align:right">12s</td>`,
  )
  expect(copied?.html).not.toMatch(/Copy|Wrap|<button|<svg/u)
})

test('a task item from the conversation’s own renderer keeps its box in both flavours', async () => {
  const { ConversationMarkdown } = await import('../components/panels/agentChat/conversationLinks')
  const view = page(
    renderToStaticMarkup(createElement(ConversationMarkdown, { text: '- [x] Ship\n- [ ] Tell people' })),
  )
  view.selectAll()
  const copied = view.copy()
  expect(copied?.text).toBe('- [x] Ship\n- [ ] Tell people')
  expect(copied?.html).toContain('<li>\u2611 Ship</li>')
  expect(copied?.html).not.toContain('<input')
})

test('a task list nested under a plain item keeps the item’s words and its sub-list in the rich flavour', () => {
  const source = '- parent\n  - [ ] sub one\n  - [x] sub two\n- other'
  const view = page(renderToStaticMarkup(createElement('div', null, renderMarkdown(source))))
  view.selectAll()
  const copied = view.copy()
  expect(copied?.text).toBe(source)
  const html = new JSDOM(copied?.html ?? '').window.document
  const parent = html.querySelector('li')!
  expect(parent.firstChild?.textContent?.trim()).toBe('parent')
  const subItems = [...parent.querySelectorAll('ul > li')]
  expect(subItems.map((item) => item.textContent?.trim())).toEqual(['\u2610 sub one', '\u2611 sub two'])
})

test('a loose task item keeps its own words and paragraphs in the rich flavour', () => {
  const view = page(
    renderToStaticMarkup(createElement('div', null, renderMarkdown('- [ ] a task\n\n  with para\n- [x] b'))),
  )
  view.selectAll()
  const html = new JSDOM(view.copy()?.html ?? '').window.document
  const items = [...html.querySelectorAll('li')]
  expect(items).toHaveLength(2)
  expect(items[0].textContent?.trim()).toMatch(/^\u2610 a task/u)
  expect(items[0].textContent).toContain('with para')
  expect(items[1].textContent?.trim()).toBe('\u2611 b')
})

test('typeset math copies back as the TeX it was written in, in both flavours', async () => {
  const { loadTypesetter } = await import('../lib/math/typesetMath')
  await loadTypesetter()
  const source = ['Energy is $$E = mc^2$$ here.', '', '$$', '\\frac{a}{b}', '$$'].join('\n')
  const view = page(renderToStaticMarkup(createElement('div', null, renderMarkdown(source, { math: true }))))
  expect(view.log.querySelectorAll('[data-math]')).toHaveLength(2)
  view.selectAll()
  const copied = view.copy()
  expect(copied?.text).toBe(source)
  expect(copied?.html).toContain('Energy is $$E = mc^2$$ here.')
  expect(copied?.html).toContain(pastedCode('\\frac{a}{b}'))
  expect(copied?.html).not.toContain('katex')
})
