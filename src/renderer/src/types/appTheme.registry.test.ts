import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { APP_THEMES, LIGHT_SURFACE_THEMES, type ThemeSwatches } from './appTheme'

// A theme lives in three places that cannot import each other: its row in
// APP_THEMES, its `:root[data-theme="<id>"]` block in index.css, and — for a
// light-surface theme — the boot script's LIGHT_SURFACES map and the
// light-only selector lists in index.css. The file header lists the steps;
// these tests are what notices when one was skipped, which otherwise shows up
// only as a theme that paints the default Dark, flashes on launch, or draws
// washed-out git lanes on paper.

const root = process.cwd()
const css = readFileSync(join(root, 'src', 'renderer', 'src', 'assets', 'index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const boot = readFileSync(join(root, 'src', 'renderer', 'public', 'boot-theme.js'), 'utf8')

const resolvedThemes = APP_THEMES.flatMap((theme) => (theme.resolved ? [theme] : []))

function themeBlock(id: string): Map<string, string> | null {
  const open = css.indexOf(`:root[data-theme="${id}"] {`)
  if (open === -1) return null
  const body = css.slice(open, css.indexOf('}', open))
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]))
}

test('every theme in the picker has its own block in index.css', () => {
  // `dark` is the bare :root block, which also names it explicitly.
  const missing = resolvedThemes.filter((theme) => !css.includes(`:root[data-theme="${theme.id}"]`))
  assert.deepEqual(
    missing.map((theme) => theme.id),
    [],
    'a theme with no block paints the default Dark',
  )
})

test("each swatch shows the colours the theme's block actually paints", () => {
  // The picker draws every theme from these literals while the document wears
  // one of them, so a swatch that drifted from its block advertises a theme
  // the person does not get. The two themes that alias the design-system
  // bundle (`var(--sem-…)`) have nothing literal to compare and are skipped.
  const fields: Array<[keyof ThemeSwatches, string]> = [
    ['bgApp', '--bg-app'],
    ['bgSurface', '--bg-surface'],
    ['bgSurfaceRaised', '--bg-surface-raised'],
    ['accent', '--accent-primary'],
    ['textStrong', '--text-strong'],
  ]
  for (const theme of resolvedThemes) {
    const block = themeBlock(theme.id)
    if (!block || !theme.swatches) continue
    for (const [field, variable] of fields) {
      const painted = block.get(variable)
      if (!painted || painted.startsWith('var(')) continue
      assert.equal(
        theme.swatches[field].toLowerCase(),
        painted.toLowerCase(),
        `${theme.id}: swatch ${field} is not the block's ${variable}`,
      )
    }
  }
})

test('the boot script pre-paints exactly the light-surface themes', () => {
  const map = /var LIGHT_SURFACES = \{([\s\S]*?)\}/.exec(boot)
  assert.ok(map, 'boot-theme.js has no LIGHT_SURFACES map')
  const ids = [...map[1]!.matchAll(/^\s*'?([\w-]+)'?\s*:/gm)].map((match) => match[1]!)
  assert.deepEqual(
    [...ids].sort(),
    [...LIGHT_SURFACE_THEMES].sort(),
    'LIGHT_SURFACES in boot-theme.js drifted from LIGHT_SURFACE_THEMES: a light theme missing from it flashes dark on launch and stamps data-mode="dark"',
  )
})

test('every light-only selector list in index.css names every light-surface theme and no other', () => {
  // A rule written for light paper (the date-picker glyph, the git lanes and
  // ref pills, the highlight palettes) lists the light themes one selector
  // each. Group the selectors of each list by what follows the theme, so a
  // list that carries two rules (a `.highlight-text-*` and a tab button) is
  // checked rule by rule.
  const lightIds = new Set<string>(LIGHT_SURFACE_THEMES)
  let lists = 0
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const selectors = match[1]!
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    const bySuffix = new Map<string, Set<string>>()
    for (const selector of selectors) {
      const theme = /^:root\[data-theme="([\w-]+)"\](.*)$/.exec(selector)
      if (!theme) continue
      const themes = bySuffix.get(theme[2]!) ?? new Set<string>()
      themes.add(theme[1]!)
      bySuffix.set(theme[2]!, themes)
    }
    for (const [suffix, themes] of bySuffix) {
      if (themes.size < 2 || ![...themes].some((id) => lightIds.has(id))) continue
      lists += 1
      assert.deepEqual(
        [...themes].sort(),
        [...lightIds].sort(),
        `the light-surface list for "${suffix.trim() || '(theme variables)'}" does not name every light theme`,
      )
    }
  }
  assert.ok(lists > 0, 'no light-surface selector lists were found; has the selector shape changed?')
})
