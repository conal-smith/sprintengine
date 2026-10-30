import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { APP_THEMES, LIGHT_SURFACE_THEMES, type ResolvedAppTheme } from '../types/appTheme'

// Text in every theme has to clear WCAG AA's 4.5:1 against the surface it sits
// on. The pairs held to it here are the ones a theme can get wrong by itself:
// the subtle ink (identifiers, paths, timestamps — small text that is read,
// not decoration) and the accent, which the app also sets type in (links,
// selected labels, the active state of a control), each against
// `--bg-surface`; and a primary button's label on the accent it fills. Read from what the app actually loads: the built
// design-system tokens in the mode a theme stamps, under index.css's blocks
// for that theme, in source order, as the cascade applies them.

const MIN_TEXT_CONTRAST = 4.5

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Top-level rules: a selector list and the declarations in its body. */
function rules(css: string): Array<{ selectors: string[]; declarations: Map<string, string> }> {
  const found: Array<{ selectors: string[]; declarations: Map<string, string> }> = []
  let depth = 0
  let start = 0
  let selector = ''
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') {
      if (depth === 0) {
        selector = css.slice(start, index).trim()
        start = index + 1
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const body = css.slice(start, index)
        found.push({
          selectors: selector.split(',').map((part) => part.trim()),
          declarations: new Map(
            [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]),
          ),
        })
        start = index + 1
      }
    }
  }
  return found
}

const tokens = rules(withoutComments(readFileSync(join(process.cwd(), 'design-system/foundations/tokens.css'), 'utf8')))
const app = rules(withoutComments(readFileSync(join(process.cwd(), 'src/renderer/src/assets/index.css'), 'utf8')))

function variablesFor(theme: ResolvedAppTheme): Map<string, string> {
  const dark = !LIGHT_SURFACE_THEMES.includes(theme)
  const variables = new Map<string, string>()
  for (const rule of tokens) {
    if (rule.selectors.includes(':root') || (dark && rule.selectors.includes('[data-mode="dark"]'))) {
      for (const [name, value] of rule.declarations) variables.set(name, value)
    }
  }
  for (const rule of app) {
    if (rule.selectors.includes(':root') || rule.selectors.includes(`:root[data-theme="${theme}"]`)) {
      for (const [name, value] of rule.declarations) variables.set(name, value)
    }
  }
  return variables
}

function colour(variables: Map<string, string>, name: string, theme: string, depth = 0): string {
  const value = variables.get(name)
  assert.ok(value, `${theme}: ${name} is not declared`)
  assert.ok(depth < 20, `${theme}: ${name} aliases itself`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (alias) return colour(variables, alias[1]!, theme, depth + 1)
  assert.match(value, /^#[0-9a-f]{6}$/i, `${theme}: ${name} is ${value}, not an opaque six-digit hex colour`)
  return value
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const THEMES = APP_THEMES.flatMap((theme) => (theme.resolved ? [theme.resolved] : []))

function failures(foreground: string, background: string): string[] {
  return THEMES.flatMap((theme) => {
    const variables = variablesFor(theme)
    const ink = colour(variables, foreground, theme)
    const surface = colour(variables, background, theme)
    const ratio = contrast(ink, surface)
    return ratio >= MIN_TEXT_CONTRAST ? [] : [`${theme}: ${ink} on ${surface} is ${ratio.toFixed(2)}:1`]
  })
}

test('every theme is read', () => {
  assert.ok(THEMES.length >= 15)
  for (const theme of THEMES) {
    assert.ok(
      app.some((rule) => rule.selectors.includes(`:root[data-theme="${theme}"]`)),
      `index.css has no block for ${theme}`,
    )
  }
})

test('subtle text clears AA on the surface in every theme', () => {
  assert.deepEqual(failures('--text-subtle', '--bg-surface'), [])
})

test('accent text clears AA on the surface in every theme', () => {
  assert.deepEqual(failures('--accent-primary', '--bg-surface'), [])
})

// The accent is a fill too, under a primary button's label: a retone that
// lifts it as text must not sink the label set on it.
test("a button's label clears AA on the accent in every theme", () => {
  assert.deepEqual(failures('--text-on-accent', '--accent-primary'), [])
})

// Raising the subtle ink must not carry it past the muted one: the ramp reads
// default, muted, subtle, disabled, strongest first, in every theme.
test('the ink ramp keeps its order on the surface in every theme', () => {
  for (const theme of THEMES) {
    const variables = variablesFor(theme)
    const surface = colour(variables, '--bg-surface', theme)
    const [defaultInk, muted, subtle, disabled] = [
      '--text-default',
      '--text-muted',
      '--text-subtle',
      '--text-disabled',
    ].map((name) => contrast(colour(variables, name, theme), surface))
    assert.ok(defaultInk! > muted!, `${theme}: muted text is as strong as default`)
    assert.ok(muted! > subtle!, `${theme}: subtle text is as strong as muted`)
    assert.ok(subtle! > disabled!, `${theme}: disabled text is as strong as subtle`)
  }
})
