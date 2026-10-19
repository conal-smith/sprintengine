// @vitest-environment jsdom
import DOMPurify from 'dompurify'
import { beforeEach, expect, test, vi } from 'vitest'

// Mermaid needs a real layout engine to measure its labels, so the renderer is
// a stand-in that records the order it is driven in. Its `render` waits a turn
// before answering, so two diagrams drawn at once would interleave if nothing
// kept them apart.
const mermaid = vi.hoisted(() => {
  const events: string[] = []
  const configs: Array<Record<string, unknown>> = []
  return {
    events,
    configs,
    api: {
      initialize: (config: Record<string, unknown>) => {
        configs.push(config)
        events.push('initialize')
      },
      parse: async (source: string) => {
        if (source.includes('broken')) throw new Error('Parse error on line 2:\n...\nExpecting NODE_STRING')
        return { diagramType: 'flowchart' }
      },
      mermaidAPI: {
        getDiagramFromText: async (source: string) => ({
          db: {
            getVertices: () =>
              new Map(source.includes('parsed-img') ? [['A', { img: 'https://evil.example/p.png' }]] : []),
          },
        }),
      },
      render: async (id: string, source: string) => {
        events.push(`start ${source}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`end ${source}`)
        return { svg: `<svg id="${id}"><text>${source}</text></svg>` }
      },
    },
  }
})
vi.mock('mermaid', () => ({ default: mermaid.api }))

const { appearanceKey, cachedDiagram, drawDiagram, LOADS_FROM_ELSEWHERE, loadsFromElsewhere, sanitizeDiagramSvg } =
  await import('./mermaidDiagram')

beforeEach(() => {
  mermaid.events.length = 0
  mermaid.configs.length = 0
})

test('diagrams are drawn one at a time, each under the configuration it was drawn with', async () => {
  const [first, second] = await Promise.all([drawDiagram('a', 'graph TD; one'), drawDiagram('a', 'graph TD; two')])
  expect(mermaid.events).toEqual([
    'initialize',
    'start graph TD; one',
    'end graph TD; one',
    'initialize',
    'start graph TD; two',
    'end graph TD; two',
  ])
  expect(first).toMatchObject({ svg: expect.stringContaining('graph TD; one') })
  expect(second).toMatchObject({ svg: expect.stringContaining('graph TD; two') })
  for (const config of mermaid.configs) {
    expect(config).toMatchObject({ securityLevel: 'strict', theme: 'base', startOnLoad: false })
  }
})

test('labels are SVG text, and a diagram cannot change what reaches the page unsanitized', async () => {
  await drawDiagram('a', 'graph TD; configured')
  const [config] = mermaid.configs
  expect(config).toMatchObject({ htmlLabels: false, flowchart: { htmlLabels: false } })
  // Mermaid's own list is replaced, not added to, so it is all still there.
  expect(config.secure).toEqual(
    expect.arrayContaining([
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'suppressErrorRendering',
      'maxEdges',
    ]),
  )
  expect(config.secure).toEqual(
    expect.arrayContaining([
      'htmlLabels',
      'themeCSS',
      'themeVariables',
      'fontFamily',
      'altFontFamily',
      'dompurifyConfig',
    ]),
  )
  expect(config.dompurifyConfig).toMatchObject({
    FORBID_TAGS: expect.arrayContaining(['style', 'a', 'img', 'image', 'script']),
    FORBID_ATTR: expect.arrayContaining(['style', 'href', 'xlink:href', 'src', 'srcset']),
  })
})

test('a source that would load an image or a style from elsewhere is not drawn', async () => {
  for (const source of [
    '%%{init: {"themeCSS": ".node rect { fill: url(https://evil.example/a.svg) }"}}%%\ngraph TD; A',
    '%%{init: {"themeCSS": "@import \'https://evil.example/b.css\';"}}%%\ngraph TD; A',
    'classDiagram\n  class A\n  style A fill:url(https://evil.example/c.png)',
    'stateDiagram-v2\n  A --> B\n  classDef bad fill:url(//evil.example/d.png)',
    // CSS reads an escaped `url(` as the real one.
    'stateDiagram-v2\n  A --> B\n  classDef bad fill:\\75 rl(https://evil.example/e.png)',
    'stateDiagram-v2\n  A --> B\n  classDef bad background:image-set("https://evil.example/f.png" 1x)',
    'flowchart TD\n  A@{ img: "https://evil.example/g.png", label: "A" }',
    'sequenceDiagram\n  participant A\n  properties A: {"icon": "https://evil.example/h.png"}',
    // HTML entities, and Mermaid's own `#…;` spelling of them, are read as
    // the characters they stand for.
    'stateDiagram-v2\n  A --> B\n  classDef bad fill:&#117;rl(https://evil.example/i.png)',
    'stateDiagram-v2\n  A --> B\n  classDef bad fill:&#x75;rl(https://evil.example/j.png)',
    'graph TD\n  A --> B\n  style A fill:u#114;l(https://evil.example/k.png)',
    'graph TD\n  A --> B\n  style A fill:url&lpar;https://evil.example/l.png)',
    'graph TD\n  A --> B\n  style A fill:url#lpar;https://evil.example/m.png)',
    'graph TD\n  A --> B\n  style A fill:&amp;#117;rl(https://evil.example/n.png)',
    'flowchart TD\n  A@{ &#105;mg: "https://evil.example/o.png" }',
  ]) {
    expect(loadsFromElsewhere(source), source).toBe(true)
    expect(await drawDiagram('a', source), source).toEqual({ error: LOADS_FROM_ELSEWHERE })
  }
  expect(mermaid.events).toEqual([])

  // The diagram pointing at its own markers, a symbol of its own, and an
  // address that is only a label's text are all fine.
  for (const source of [
    'graph TD\n  A --> B\n  style A fill:#f9f',
    'graph TD\n  A["Fetch https://api.example.com/v1"] --> B',
    'sequenceDiagram\n  participant A\n  properties A: {"icon": "@clock"}',
    'graph TD\n  A["Tom &amp; Jerry #9829;"] --> B\n  style B fill:#f9f;',
  ]) {
    expect(loadsFromElsewhere(source), source).toBe(false)
  }
})

test('a node image only the parsed diagram shows is not drawn either', async () => {
  const source = 'flowchart TD\n  A --> B %% parsed-img'
  expect(loadsFromElsewhere(source)).toBe(false)
  expect(await drawDiagram('a', source)).toEqual({ error: LOADS_FROM_ELSEWHERE })
  expect(mermaid.events).toEqual(['initialize'])
})

test('a diagram is drawn once per appearance and source, however often it is asked for', async () => {
  const asked = await Promise.all([drawDiagram('light', 'graph LR; cached'), drawDiagram('light', 'graph LR; cached')])
  expect(asked[0]).toBe(asked[1])
  expect(mermaid.events.filter((event) => event.startsWith('start'))).toHaveLength(1)
  expect(cachedDiagram('light', 'graph LR; cached')).toBe(asked[0])
  expect(await drawDiagram('light', 'graph LR; cached')).toBe(asked[0])
  expect(mermaid.events.filter((event) => event.startsWith('start'))).toHaveLength(1)

  // Another appearance is another drawing: its colours are baked into the SVG.
  expect(cachedDiagram('dark', 'graph LR; cached')).toBeUndefined()
  await drawDiagram('dark', 'graph LR; cached')
  expect(mermaid.events.filter((event) => event.startsWith('start'))).toHaveLength(2)
})

test('a source that does not parse resolves to its error, is never drawn, and is not parsed again', async () => {
  const result = await drawDiagram('a', 'graph TD\n  broken -->')
  expect(result).toEqual({ error: expect.stringContaining('Parse error on line 2') })
  expect(mermaid.events).toEqual(['initialize'])
  await drawDiagram('a', 'graph TD\n  broken -->')
  expect(mermaid.events).toEqual(['initialize'])
})

test('the appearance is the theme and the mode the document root carries', () => {
  document.documentElement.setAttribute('data-theme', 'paper')
  document.documentElement.setAttribute('data-mode', 'light')
  expect(appearanceKey()).toBe('paper|light')
})

test('the SVG keeps its drawing and labels and loses anything that could run', () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">',
    '<style>#d .node rect{fill:#eee}</style>',
    '<script>alert(2)</script>',
    '<a href="javascript:alert(3)"><rect width="4" height="4"/></a>',
    '<g class="label"><foreignObject width="40" height="20">',
    '<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Start</p></span>',
    '<img src="x" onerror="alert(4)"></div>',
    '</foreignObject></g>',
    '<path d="M0 0L10 10" marker-end="url(#d_arrow)"/>',
    '</svg>',
  ].join('')
  const clean = sanitizeDiagramSvg(DOMPurify, svg)
  expect(clean).not.toMatch(/onload|onerror|<script|javascript:/u)
  expect(clean).toContain('<style>')
  expect(clean).toContain('<foreignObject')
  expect(clean).toContain('<p>Start</p>')
  // A link's drawing stays; the link does not.
  expect(clean).toContain('<rect width="4" height="4"')
  expect(clean).toContain('marker-end="url(#d_arrow)"')
})

// A note label as Mermaid draws one for `$$…$$` text: KaTeX's MathML in a foreignObject.
function mathNote(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><foreignObject height="34" width="35"><div xmlns="http://www.w3.org/1999/xhtml"><span class="katex">${label}</span></div></foreignObject></svg>`
}

function sanitizedInto(svg: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = sanitizeDiagramSvg(DOMPurify, svg)
  return host
}

test('a math label keeps the MathML KaTeX typeset it in', () => {
  const host = sanitizedInto(
    mathNote(
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mfrac><mi>d</mi><mrow><mi>d</mi><mi>x</mi></mrow></mfrac><mrow><mo fence="true">(</mo><mi mathvariant="bold">v</mi><mo fence="true">)</mo></mrow><msqrt><mn>2</mn></msqrt></mrow></math>',
    ),
  )
  const math = host.querySelector('.katex > math')
  expect(math?.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
  expect(math?.getAttribute('display')).toBe('block')
  expect(math?.querySelector('mfrac')?.textContent).toBe('ddx')
  expect(math?.querySelector('msqrt')?.textContent).toBe('2')
  expect(math?.querySelector("mi[mathvariant='bold']")?.textContent).toBe('v')
  expect(math?.querySelectorAll("mo[fence='true']")).toHaveLength(2)
})

test('a math label loses links, handlers and the MathML KaTeX never writes', () => {
  const host = sanitizedInto(
    mathNote(
      '<math href="javascript:alert(1)"><mi href="javascript:alert(1)" onclick="alert(1)">x</mi><maction actiontype="toggle"><mi>a</mi></maction><mglyph src="https://example.com/a.png"></mglyph><annotation-xml encoding="text/html"><img src="x" onerror="alert(1)"></annotation-xml><semantics><mi>y</mi><annotation encoding="application/x-tex">y</annotation></semantics></math>',
    ),
  )
  expect(host.querySelector('math mi')?.textContent).toBe('x')
  expect(host.querySelector('[href], [onclick], [src], [onerror]')).toBeNull()
  expect(host.querySelector('maction, mglyph, annotation-xml, annotation, semantics, img')).toBeNull()
})

test('MathML is taken only as a label, and its attributes only on MathML', () => {
  const host = sanitizedInto(
    '<svg xmlns="http://www.w3.org/2000/svg"><math><mi>x</mi></math><text mathvariant="bold" fence="true">label</text></svg>',
  )
  expect(host.querySelector('math, mi')).toBeNull()
  expect(host.querySelector('text')?.getAttributeNames()).toEqual([])
})

test('the SVG loses everything that would load from elsewhere', () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">',
    '<style>@import url(https://evil.example/a.css);',
    '@import "https://evil.example/b.css";',
    '#d .node rect{fill:url(https://evil.example/c.svg)}',
    '#d .edge{stroke:url( "//evil.example/d.svg" )}',
    '#d .cluster{background:image-set("https://evil.example/e.png" 1x)}',
    '#d .note{background:\\75 rl(https://evil.example/f.png)}',
    '#d .marker{fill:url(#d_gradient)}</style>',
    '<image href="https://evil.example/g.png" width="4" height="4"/>',
    '<image xlink:href="https://evil.example/h.png" width="4" height="4"/>',
    '<a href="https://evil.example/i"><text>linked</text></a>',
    '<rect width="4" height="4" style="fill:url(https://evil.example/j.png)" filter="url(https://evil.example/k.svg#f)"/>',
    '<foreignObject width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml">',
    '<img src="https://evil.example/l.png" srcset="https://evil.example/m.png 2x">',
    '<span style="background-image:url(https://evil.example/n.png)">Label</span></div></foreignObject>',
    '<path d="M0 0L10 10" marker-end="url(#d_arrow)"/>',
    '</svg>',
  ].join('')
  const clean = sanitizeDiagramSvg(DOMPurify, svg)
  expect(clean).not.toContain('evil.example')
  expect(clean).not.toMatch(/<img|<image|<a\b|@import|image-set|\bsrc=|href=/u)
  // What the diagram draws, and what it points at inside itself, stay.
  expect(clean).toContain('<text>linked</text>')
  expect(clean).toContain('Label</span>')
  expect(clean).toContain('fill:url(#d_gradient)')
  expect(clean).toContain('marker-end="url(#d_arrow)"')
})

test('a renderer that fails to load is asked for again, and says the failure is worth retrying', async () => {
  vi.resetModules()
  vi.doMock('mermaid', () => {
    throw new Error('Failed to fetch dynamically imported module')
  })
  const fresh = await import('./mermaidDiagram')
  const failed = await fresh.drawDiagram('a', 'graph TD; offline')
  expect(failed).toEqual({ error: 'The diagram renderer could not be loaded', retry: true })
  expect(fresh.cachedDiagram('a', 'graph TD; offline')).toBeUndefined()

  vi.doMock('mermaid', () => ({ default: mermaid.api }))
  expect(await fresh.drawDiagram('a', 'graph TD; offline')).toMatchObject({ svg: expect.stringContaining('offline') })
  vi.doUnmock('mermaid')
})
