import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test, expect } from 'vitest'
import {
  ConversationLinkProvider,
  ConversationMarkdown,
  splitConversationText,
  splitProseLinkToken,
} from './conversationLinks'
import { classifyLinkToken } from '../../../../../shared/links/classifyLinkToken'
import { conversationImageSource } from './ConversationImage'
import { resolveTerminalFileReferencePath } from '../../../utils/terminalFileLinks'
import {
  ConversationTransportProvider,
  useConversationTransport,
  type ConversationTransport,
} from './conversationTransport'

function render(text: string) {
  return renderToStaticMarkup(
    <ConversationLinkProvider workspaceId="workspace" workspaceRoot="/workspace/app" cwd="/workspace/app">
      <ConversationMarkdown text={text} />
    </ConversationLinkProvider>,
  )
}

test('links paths in prose, inline code, and markdown hrefs', () => {
  const html = render(
    'See src/main/app.ts:42 and `./package.json`, `C:\\src\\main.ts:5`, `/Users/dev/app.ts`, `../lib/a.ts` or [source](src/app.ts#L8).',
  )
  expect((html.match(/aria-label="Open /g) ?? []).length).toBe(6)
  expect(html).toContain('app.ts:42')
})

test('does not mistake prose, app routes or versions for files', () => {
  expect(render('`foo.bar()` `/settings` `1.2.3`')).not.toContain('aria-label="Open ')
})

test('fenced source stays plain selectable code and hostile schemes are inert', () => {
  const html = render('```unknown\nsrc/main.ts\n```\n\n[unsafe](javascript:alert) [website](https://example.com/path)')
  expect(html).not.toContain('aria-label="Open ')
  expect(html).not.toContain('href="javascript:')
  expect(html).toContain('href="https://example.com/path"')
})

test('file chips preserve surrounding prose punctuation and balanced URL parentheses', () => {
  expect(splitProseLinkToken('(src/app.ts:4),')).toEqual({ prefix: '(', body: 'src/app.ts:4', suffix: '),' })
  expect(splitProseLinkToken('https://example.com/page_(one).')).toEqual({
    prefix: '',
    body: 'https://example.com/page_(one)',
    suffix: '.',
  })
  const markup = render('See (src/app.ts:4), then continue.')
  expect(markup).toContain('aria-label="Open src/app.ts:4"')
  expect(markup).toContain('), then continue.')
})

test('markdown links keep their label', () => {
  const html = render('Read [the setup guide](https://example.com/setup) and [the entry point](src/app.ts:4).')
  expect(html).toContain('>the setup guide</a>')
  expect(html).not.toContain('>https://example.com/setup<')
  expect(html).toContain('the entry point')
  expect(html).toContain('aria-label="Open src/app.ts:4"')
  expect(render('[plain words](not a link)')).toContain('plain words')
})

test('a host and port in inline code is not a file reference', () => {
  expect(render('Serve on `localhost:3000`, `127.0.0.1:8080` or `example.com:443`.')).not.toContain('aria-label="Open ')
  expect(render('`server.ts:3000`')).toContain('aria-label="Open server.ts:3000"')
})

function nestedInteractiveElements(html: string): number {
  let depth = 0
  let nested = 0
  for (const [, closing] of html.matchAll(/<(\/?)(?:a|button)\b[^>]*>/g)) {
    if (closing) depth--
    else if (depth++ > 0) nested++
  }
  return nested
}

test('a link whose label is inline code or a path is one control, not a chip inside a link', () => {
  for (const text of [
    'See [`src/app.ts`](src/app.ts:4).',
    'See [`src/app.ts`](https://example.com/x).',
    'See [**bold** src/b.ts](src/b.ts).',
    'See [*see* `lib/a.ts:3`](https://example.com/y).',
  ]) {
    const html = render(text)
    expect(nestedInteractiveElements(html), html).toBe(0)
    expect((html.match(/<(?:a|button)\b/g) ?? []).length, html).toBe(1)
  }
  const html = render('See [`src/app.ts`](src/app.ts:4).')
  expect(html).toContain('aria-label="Open src/app.ts:4"')
  expect(html).toMatch(/<code[^>]*>src\/app\.ts<\/code>/)
})

test('a folder path in inline code is the code itself: no chip, no file glyph, not shortened', () => {
  const html = render('Working in `/Users/dev/project` on `main`.')
  expect(html).not.toContain('aria-label="Open ')
  expect(html).not.toContain('<svg')
  expect(html).toMatch(/<code[^>]*>\/Users\/dev\/project<\/code>/)
  // One inline-code treatment for a path and a branch name alike.
  const codeClass = (value: string) => new RegExp(`<code class="([^"]*)">${value}</code>`).exec(html)?.[1]
  expect(codeClass('\\/Users\\/dev\\/project')).toBe(codeClass('main'))
})

test('a file path is an inline link at the text’s own size, showing the whole path', () => {
  const html = render('Edit `src/renderer/src/app/main.ts:12` next.')
  expect(html).toContain('aria-label="Open src/renderer/src/app/main.ts:12"')
  expect(html).toContain('>src/renderer/src/app/main.ts:12</button>')
  expect(html).not.toContain('<svg')
})

test('a quoted path with spaces is one link, its quotes left as text around it', () => {
  const path = '/var/folders/x/Screenshot 2026-09-27 at 22.41.31.png'
  expect(splitConversationText(`Saved to '${path}'.`)).toEqual(["Saved to '", { token: path }, "'."])
  expect(splitConversationText(`Open "./My Notes.md" or ~/x.ts`)).toEqual([
    'Open "',
    { token: './My Notes.md' },
    '" or ',
    { token: '~/x.ts' },
  ])
  const html = render(`Saved to '${path}'.`)
  expect(html).toContain(`aria-label="Open ${path}"`)
  expect(html).toContain(`&#x27;<button`)
  expect(html).toContain(`</button>&#x27;.`)
})

test('a path with backslash-escaped spaces is one link that keeps the text as written', () => {
  expect(splitConversationText('Edit /Users/dev/My\\ File.ts, then run.')).toEqual([
    'Edit ',
    { token: '/Users/dev/My File.ts', label: '/Users/dev/My\\ File.ts' },
    ', then run.',
  ])
  const html = render('Edit /Users/dev/My\\ File.ts next.')
  expect(html).toContain('aria-label="Open /Users/dev/My File.ts"')
  expect(html).toContain('>/Users/dev/My\\ File.ts</button>')
  // The same path in inline code, quoted or escaped, is one link too.
  expect(render("`'/Users/dev/My File.ts'`")).toContain('aria-label="Open /Users/dev/My File.ts"')
  expect(render('`/Users/dev/My\\ File.ts`')).toContain('aria-label="Open /Users/dev/My File.ts"')
})

test('quotes that do not wrap a path are prose, and apostrophes stay words', () => {
  expect(splitConversationText("it's 'not a path' here")).toEqual(["it's 'not a path' here"])
  expect(render("Don't touch '/Users/dev/app.ts' yet.")).toContain('aria-label="Open /Users/dev/app.ts"')
})

function RemoteFiles({ children }: { children: React.ReactNode }) {
  const local = useConversationTransport()
  const remote: ConversationTransport = {
    ...local,
    kind: 'remote',
    capabilities: { ...local.capabilities, localFiles: false },
  }
  return <ConversationTransportProvider value={remote}>{children}</ConversationTransportProvider>
}

test('an image in a reply is shown: a data URL directly, a local path once it is read, a web one on request', () => {
  // A web image would be a request to a host the reply chose, made on render;
  // it waits for a click and names the host it would load from.
  const web = render('![The chart](https://example.com/chart.png)')
  expect(web).not.toContain('<img')
  expect(web).toContain('[Image: The chart] · load from example.com')
  expect(render('![dot](data:image/png;base64,iVBORw0KGgo=)')).toContain('src="data:image/png;base64,iVBORw0KGgo="')
  // A local file is read through main after mount; until then its alt text holds the place.
  const local = render('![Screenshot](<./shots/Screen Shot.png>)')
  expect(local).not.toContain('<img')
  expect(local).toContain('Screenshot')
  // A script or an unknown scheme is never a source.
  for (const src of ['javascript:void(0)', 'data:text/html;base64,PHA+', 'ftp://example.com/a.png']) {
    const html = render(`![bad](${src})`)
    expect(html, src).not.toContain('<img')
    expect(html, src).toContain('[Image: bad]')
  }
})

test('an image path from another machine says where it is instead of loading', () => {
  const html = renderToStaticMarkup(
    <RemoteFiles>
      <ConversationLinkProvider workspaceId="workspace" workspaceRoot="/workspace/app" cwd="/workspace/app">
        <ConversationMarkdown text="![Screenshot](/Users/dev/Desktop/shot.png)" />
      </ConversationLinkProvider>
    </RemoteFiles>,
  )
  expect(html).toContain('[Image: Screenshot]')
  expect(html).toContain('the image is not on this machine')
})

test('an image in the agent’s home folder is read on this machine, though a terminal never links one', () => {
  // Read through main after mount, which knows the home folder; until then the alt text holds the place.
  const html = render('![shot](~/Desktop/shot.png)')
  expect(html).not.toContain('not on this machine')
  expect(html).not.toContain('[Image: shot]')
  expect(html).toContain('shot')
  expect(resolveTerminalFileReferencePath('~/Desktop/shot.png', { workspaceRoot: '/workspace/app' })).toBeNull()
})

const WSL_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'

test('an image in the home folder of a chat in WSL or on another machine is not looked for here', () => {
  const wsl = renderToStaticMarkup(
    <ConversationLinkProvider workspaceId="workspace" workspaceRoot={WSL_ROOT} cwd={WSL_ROOT}>
      <ConversationMarkdown text="![shot](~/Desktop/shot.png)" />
    </ConversationLinkProvider>,
  )
  expect(wsl).toContain('[Image: shot]')
  const remote = renderToStaticMarkup(
    <RemoteFiles>
      <ConversationLinkProvider workspaceId="workspace" workspaceRoot="/workspace/app" cwd="/workspace/app">
        <ConversationMarkdown text="![shot](~/Desktop/shot.png)" />
      </ConversationLinkProvider>
    </RemoteFiles>,
  )
  expect(remote).toContain('the image is not on this machine')
})

test('an image source is classified before anything is loaded', () => {
  expect(conversationImageSource('https://example.com/a.png')).toEqual({
    kind: 'web',
    url: 'https://example.com/a.png',
  })
  expect(conversationImageSource('shots/My%20Shot.png')).toEqual({ kind: 'path', path: 'shots/My Shot.png' })
  expect(conversationImageSource('file:///Users/dev/a%20b.png')).toEqual({ kind: 'path', path: '/Users/dev/a b.png' })
  expect(conversationImageSource('file:///C:/shots/a.png')).toEqual({ kind: 'path', path: 'C:/shots/a.png' })
  expect(conversationImageSource('C:\\shots\\a.png')).toEqual({ kind: 'path', path: 'C:\\shots\\a.png' })
  expect(conversationImageSource('src/app.ts')).toBeNull()
  expect(conversationImageSource('javascript:void(0)')).toBeNull()
})

test('a finished shell block offers to paste itself into a terminal; other blocks do not', () => {
  expect(render('```bash\nnpm test\n```')).toContain('aria-label="Paste into terminal"')
  expect(render('```zsh\nls -la\n```')).toContain('aria-label="Paste into terminal"')
  expect(render('```ts\nconst a = 1\n```')).not.toContain('aria-label="Paste into terminal"')
  expect(render('```\nnpm test\n```')).not.toContain('aria-label="Paste into terminal"')
  const remote = renderToStaticMarkup(
    <RemoteFiles>
      <ConversationLinkProvider workspaceId="workspace" workspaceRoot="/workspace/app" cwd="/workspace/app">
        <ConversationMarkdown text={'```bash\nnpm test\n```'} />
      </ConversationLinkProvider>
    </RemoteFiles>,
  )
  expect(remote).not.toContain('aria-label="Paste into terminal"')
})

test('a shell block goes in whole only where the shell takes a bracketed paste, and never runs', async () => {
  const { terminalPastePlan } = await import('./ConversationCodeBlock')
  expect(terminalPastePlan('npm test\nnpm run build', true)).toEqual({
    kind: 'paste',
    data: '\u001b[200~npm test\nnpm run build\u001b[201~',
  })
  // Without one, a newline would run what came before it.
  expect(terminalPastePlan('npm test', false)).toEqual({ kind: 'type', data: 'npm test' })
  expect(terminalPastePlan('npm test\nnpm run build', false)).toEqual({ kind: 'copy' })
})

test('the shell turning bracketed paste on is seen even when the toggle arrives in pieces', async () => {
  const { bracketedPasteTracker } = await import('./ConversationCodeBlock')
  const track = bracketedPasteTracker()
  expect(track('Last login: Sun Sep 27\r\n')).toBe(false)
  expect(track('dev@mac-mini project % \u001b[?20')).toBe(false)
  expect(track('04h')).toBe(true)
  expect(track('more prompt text')).toBe(true)
  // A command that ran from an rc file turns it off; the next prompt, back on.
  const later = bracketedPasteTracker()
  expect(later('\u001b[?2004h\u001b[?2004l')).toBe(false)
  expect(later('$ \u001b[?2004h')).toBe(true)
})

test('prose words that cannot be links stay text, and every word that can keeps its link', () => {
  const words = [
    'the',
    'README',
    'package.json',
    'www.example.com',
    'example.com',
    'localhost:3000',
    'src/app.ts',
    './run.sh',
    '~/notes.md',
    '/Users/dev/project/a.ts:12',
    'C:\\Users\\dev\\a.ts',
    '\\\\server\\share\\a.ts',
    'https://example.com/docs',
    'mailto:dev@example.com',
    'file:///tmp/a.ts',
    'a.ts:12',
    '(see',
    'e.g.',
    'v1.2.3',
    'Makefile',
    'github.com/acme/app',
  ]
  for (const platform of ['darwin', 'win32']) {
    for (const word of words) {
      for (const text of [word, `(${word}),`, `"${word}".`]) {
        const linkable = splitConversationText(text).some((piece) => typeof piece !== 'string')
        const { body } = splitProseLinkToken(text)
        const accepted = classifyLinkToken(body, { source: 'text', cwd: '/workspace/app', platform }) !== null
        if (accepted) expect(linkable, `${text} on ${platform}`).toBe(true)
      }
    }
  }
  expect(splitConversationText('Plain words, with punctuation. And e.g. v1.2 too!')).toEqual([
    'Plain words, with punctuation. And e.g. v1.2 too!',
  ])
})
