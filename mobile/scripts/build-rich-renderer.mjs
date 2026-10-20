// Builds the page the phone's diagram and formula renderer runs
// (`src/components/document/rich/richRendererDocument.generated.ts`): one
// HTML document holding Mermaid, KaTeX and its faces, and the renderer's own
// scripts, so a diagram or a formula draws with no network at all.
//
//   npm run build:renderer           writes it
//   npm run build:renderer -- --check fails if it is out of date
//
// Mermaid and KaTeX are pinned exactly in devDependencies: nothing of either
// is bundled into the app's JavaScript but this one string. KaTeX's faces go
// in as TrueType, which the renderer both adds to the page and reads the
// outlines of. The page's policy allows its own scripts by hash and nothing
// else; it may fetch nothing.
//
// The generated file records a digest of everything it was built from;
// `richRenderer.regression.test.js` fails when the inputs move without it.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const modules = join(repoRoot, 'node_modules')
const rendererDir = join(repoRoot, 'src/components/document/rich/renderer')
export const OUTPUT = join(repoRoot, 'src/components/document/rich/richRendererDocument.generated.ts')

const read = (path) => readFileSync(path, 'utf8')
const version = (name) => JSON.parse(read(join(modules, name, 'package.json'))).version

/** Every input, in a fixed order, as `[label, bytes]`. */
function inputs() {
  const katexDist = join(modules, 'katex/dist')
  const css = read(join(katexDist, 'katex.min.css'))
  const faces = fontFaces(css)
  return {
    css,
    faces,
    list: [
      ['mermaid', `${version('mermaid')}`],
      ['katex', `${version('katex')}`],
      ['mermaid.min.js', readFileSync(join(modules, 'mermaid/dist/mermaid.min.js'))],
      ['katex.min.js', readFileSync(join(katexDist, 'katex.min.js'))],
      ['katex.min.css', css],
      ...faces.map((face) => [face.file, readFileSync(join(katexDist, face.file))]),
      ['ttfGlyphs.js', readFileSync(join(rendererDir, 'ttfGlyphs.js'))],
      ['rendererMain.js', readFileSync(join(rendererDir, 'rendererMain.js'))],
      ['build-rich-renderer.mjs', readFileSync(fileURLToPath(import.meta.url))],
    ],
  }
}

/** The digest the generated file must carry. */
export function inputsDigest() {
  const hash = createHash('sha256')
  for (const [label, bytes] of inputs().list) {
    hash.update(label)
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** katex.css's faces: each family, weight and style, and its TrueType file. */
function fontFaces(css) {
  const faces = []
  for (const [, body] of css.matchAll(/@font-face\{([^}]*)\}/g)) {
    const family = /font-family:([^;]+)/.exec(body)?.[1].trim()
    const style = /font-style:([^;]+)/.exec(body)?.[1].trim() ?? 'normal'
    const weight = Number(/font-weight:([^;]+)/.exec(body)?.[1].trim() ?? 400)
    const file = /url\(fonts\/([^)]+\.ttf)\)/.exec(body)?.[1]
    if (!family || !file) throw new Error(`An @font-face in katex.min.css has no family or TrueType file: ${body}`)
    faces.push({ family, style, weight, file: `fonts/${file}` })
  }
  if (faces.length < 20) throw new Error(`katex.min.css declares ${faces.length} faces; expected its 20`)
  return faces
}

// Hermes keeps a string that holds anything outside ASCII as UTF-16, two
// bytes a character: four megabytes of page would weigh eight in the app.
// Mermaid's few such characters sit in its strings and regular expressions,
// where `\uXXXX` means the same character; the page is checked to be ASCII.
const asciiOnly = (source) =>
  source.replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** Script text that cannot end or re-enter the element it sits in, in ASCII. */
const inlineScript = (source) => asciiOnly(source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'))
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('base64')

export function documentHtml() {
  const { css, faces } = inputs()
  const katexDist = join(modules, 'katex/dist')
  const fonts = faces.map((face) => ({
    family: face.family,
    weight: face.weight,
    style: face.style,
    data: readFileSync(join(katexDist, face.file)).toString('base64'),
  }))
  const scripts = [
    `window.__richFonts=${JSON.stringify(fonts)};`,
    read(join(katexDist, 'katex.min.js')),
    read(join(modules, 'mermaid/dist/mermaid.min.js')),
    read(join(rendererDir, 'ttfGlyphs.js')),
    read(join(rendererDir, 'rendererMain.js')),
  ].map(inlineScript)
  // The faces are added from memory by the renderer; the stylesheet's own
  // rules would only ask for files the page may not fetch.
  const katexCss = css.replace(/@font-face\{[^}]*\}/g, '')
  const pageCss = [
    // A diagram that sizes itself to its container (a Gantt chart) is laid
    // out in a column this wide, not in the page's one-pixel window; the
    // phone scales it to its own.
    'html,body{margin:0;padding:0;background:transparent}',
    'body{width:640px}',
    '#stage{position:absolute;left:0;top:0;width:4000px}',
    '.formula{position:absolute;left:0;top:0;display:inline-block;white-space:nowrap}',
    '.formula .katex-display{margin:0}',
    '.baseline{display:inline-block;width:0;height:0;vertical-align:baseline}',
    '.diagram{position:absolute;left:0;top:0}',
  ].join('')
  const policy = [
    "default-src 'none'",
    `script-src ${scripts.map((script) => `'sha256-${sha256(script)}'`).join(' ')}`,
    "style-src 'unsafe-inline'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>${katexCss}${pageCss}</style>`,
    '</head><body><div id="stage"></div>',
    ...scripts.map((script) => `<script>${script}</script>`),
    '</body></html>',
  ].join('')
  const outside = /[^\x00-\x7f]/.exec(html)
  if (outside) throw new Error(`The renderer page holds a character outside ASCII: U+${outside[0].codePointAt(0).toString(16)}`)
  return html
}

function generated() {
  const html = documentHtml()
  // JSON is a JavaScript string literal but for two line separators.
  const literal = JSON.stringify(html).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return [
    '// Generated by scripts/build-rich-renderer.mjs: `npm run build:renderer`. Do not edit.',
    `// Mermaid ${version('mermaid')}, KaTeX ${version('katex')} and its faces, and src/components/document/rich/renderer.`,
    '',
    '/** A digest of everything the document was built from; the regression suite checks it. */',
    `export const RICH_RENDERER_INPUTS = "${inputsDigest()}";`,
    '',
    '/** The renderer page, whole. */',
    `export const RICH_RENDERER_DOCUMENT: string = ${literal};`,
    '',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const check = process.argv.includes('--check')
  const next = generated()
  let current = ''
  try {
    current = read(OUTPUT)
  } catch {
    current = ''
  }
  if (check) {
    if (current !== next) {
      console.error('The renderer document is out of date: run `npm run build:renderer`.')
      process.exit(1)
    }
    console.log('The renderer document is current.')
  } else {
    writeFileSync(OUTPUT, next)
    console.log(`Wrote ${OUTPUT} (${(Buffer.byteLength(next) / 1024).toFixed(0)} KB).`)
  }
}
