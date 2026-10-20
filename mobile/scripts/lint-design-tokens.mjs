// Design-token conformance gate for the app's own source.
//
// The mobile app cannot run `design-system/scripts/lint.mjs` — that one reads CSS,
// and this app has none. This is the React Native counterpart of the same three
// rules, over `src/**/*.ts(x)`:
//
//   raw-color      a hex literal outside the token file
//   raw-spacing    a numeric literal on padding/margin/gap
//   raw-font       a fontFamily that is not one of the two family tokens
//   raw-weight     a numeric fontWeight literal instead of the three-step token
//   accent-fill    the brand green as a fill outside the controls allowed one
//
// It exists because of what the desktop learned the hard way: its own conformance
// lint held a TEXT_SIZE regex but fed it only to a floor check, so it ran green
// over 1,425 arbitrary type sizes for as long as they existed. A guard that cannot
// fail is not a guard, which is why `npm run lint:tokens -- --selftest` exists and
// runs in CI: it feeds the checker known-bad source and fails if the checker
// reports it clean.
//
// Escape hatch, mirroring the design system's: put `design-tokens-allow: <reason>`
// on the same line or one of the two lines above. The reason is mandatory.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(repoRoot, 'src')

// The token file is where values are ALLOWED to be literal — it is the source of
// truth this lint exists to protect. Same carve-out the design system gives
// `foundations/tokens.tokens.json`.
const TOKEN_FILES = ['src/theme/tokens.ts']

// Brand assets are keyed hexes cut from artwork, not theme ink; the glyph pack's
// role accents are the documented per-role colour exception and are already pinned
// at their contrast floor by glyphContrast.regression.test.js.
const COLOR_EXEMPT = [
  'src/theme/tokens.ts',
  'src/components/glyphs/roleRegistry.ts',
  'src/features/backlog/backlogLogic.ts',
]

// Green is brand, not accent: it inks the wordmark, the focus ring and a live
// mark, and fills only a control whose whole point is "on" or "go" (see
// the note atop src/theme/tokens.ts). Every other fill
// is the neutral `buttonBg`. Without this rule the exception widens one
// "just this once" at a time, and green stops meaning anything.
const ACCENT_FILL_ALLOWED = [
  'src/components/SendButton.tsx', // the composer's round send
  'src/components/Toggle.tsx', // a switch's track while it is on
  'src/features/dictation/DictationButton.tsx', // the microphone while it listens
]
const ACCENT_FILL = /\b(backgroundColor\s*:|fill\s*=\s*\{)\s*colors\.accentPrimary\b(?![A-Za-z])/

const HEX = /#[0-9a-fA-F]{3,8}\b/
const SPACING_PROP = /\b(padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingHorizontal|paddingVertical|margin|marginTop|marginBottom|marginLeft|marginRight|marginHorizontal|marginVertical|gap|rowGap|columnGap)\s*:\s*(-?\d+(?:\.\d+)?)\s*[,}]/
const FONT_FAMILY = /\bfontFamily\s*:\s*["'][^"']+["']/
const FONT_WEIGHT = /\bfontWeight\s*:\s*["']?\d+["']?/
const ALLOW = /design-tokens-allow:\s*\S/

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    // Generated files (`*.generated.ts`) carry their own literals and are not app source.
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/\.generated\.ts$/.test(entry)) out.push(full)
  }
  return out
}

/** An allow comment on this line or either of the two above it. */
function allowed(lines, index) {
  for (let i = Math.max(0, index - 2); i <= index; i += 1) {
    if (ALLOW.test(lines[i] ?? '')) return true
  }
  return false
}

export function checkSource(relPath, source) {
  const violations = []
  const lines = source.split('\n')

  lines.forEach((rawLine, index) => {
    if (allowed(lines, index)) return
    // Comments are prose about values, not values. A note naming the hexes a
    // third-party library hardcodes is documentation; flagging it would teach
    // authors to delete the explanation rather than the literal.
    const line = rawLine.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
    const at = `${relPath}:${index + 1}`

    if (HEX.test(line) && !COLOR_EXEMPT.includes(relPath)) {
      violations.push({ rule: 'raw-color', at, text: 'hex literal — use a theme token' })
    }
    const spacing = SPACING_PROP.exec(line)
    // 0 is not a scale step; it is the absence of space, and every scale would
    // need a zero token for no gain.
    if (spacing && spacing[2] !== '0' && !TOKEN_FILES.includes(relPath)) {
      violations.push({ rule: 'raw-spacing', at, text: `${spacing[1]}: ${spacing[2]} — use space.*` })
    }
    if (FONT_FAMILY.test(line) && !TOKEN_FILES.includes(relPath) && !/monoFontFamily/.test(line)) {
      violations.push({ rule: 'raw-font', at, text: 'fontFamily — use monoFontFamily, or the UI default' })
    }
    // Three weights per the system, and at most three per view. A numeric literal
    // is how a fourth arrives without anyone deciding to add one.
    if (FONT_WEIGHT.test(line) && !TOKEN_FILES.includes(relPath)) {
      violations.push({ rule: 'raw-weight', at, text: 'numeric fontWeight — use fontWeight.*' })
    }
    if (ACCENT_FILL.test(line) && !ACCENT_FILL_ALLOWED.includes(relPath)) {
      violations.push({ rule: 'accent-fill', at, text: 'green fill — use buttonBg, or ink with accentPrimary' })
    }
  })

  return violations
}

// Proof by construction: if the checker cannot fail, it is decoration. CI runs
// this, so a refactor that neuters a rule breaks the build rather than going
// quietly green the way the desktop's type guard did.
function selftest() {
  const cases = [
    ['raw-color', 'const a = { color: "#ff0000" };'],
    ['raw-spacing', 'const a = { padding: 13 };'],
    ['raw-font', 'const a = { fontFamily: "Comic Sans" };'],
    ['raw-weight', 'const a = { fontWeight: "700" };'],
    ['accent-fill', 'const a = { backgroundColor: colors.accentPrimary };'],
  ]
  const failures = []
  for (const [rule, source] of cases) {
    const found = checkSource('src/fixture.ts', source)
    if (!found.some((violation) => violation.rule === rule)) {
      failures.push(`${rule} did not fire on: ${source}`)
    }
  }
  // And the escape hatch must actually work, or authors will delete the rule
  // instead of annotating the one legitimate exception.
  if (checkSource('src/fixture.ts', '// design-tokens-allow: keyed brand artwork\nconst a = "#ff0000";').length > 0) {
    failures.push('the allow comment did not suppress a violation')
  }
  // The accent rule must not catch the soft tints, nor the controls allowed the fill.
  if (checkSource('src/fixture.ts', 'const a = { backgroundColor: colors.accentPrimarySoft };').length > 0) {
    failures.push('accent-fill fired on a soft tint')
  }
  if (checkSource('src/components/SendButton.tsx', 'const a = { backgroundColor: colors.accentPrimary };').length > 0) {
    failures.push('accent-fill fired on the send, which is allowed the fill')
  }
  if (failures.length > 0) {
    console.error('lint-design-tokens SELFTEST FAILED:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
  console.log('lint-design-tokens selftest: 8/8 — every rule fires, the allow comment suppresses, and the green fill stays scoped')
}

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  const violations = sourceFiles(sourceRoot).flatMap((file) =>
    checkSource(relative(repoRoot, file), readFileSync(file, 'utf8')),
  )
  for (const violation of violations) {
    console.error(`${violation.at}  ${violation.rule}  ${violation.text}`)
  }
  console.log(`\nlint-design-tokens: ${violations.length} violation(s)`)
  process.exit(violations.length > 0 ? 1 : 0)
}
