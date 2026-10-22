#!/usr/bin/env node
// Design-system conformance guard.
//
// The product is held to `design-system/foundations/principles.md`. This guard
// carries the mechanical clauses of that document — the ones a machine can
// decide — plus two rules about the token layer itself. It is a sibling of
// `scripts/lint-design-tokens.mjs` and the rest of the `npm run lint` family;
// it never duplicates a rule one of them already owns (native `title=` on a
// control is theirs, not ours).
//
// ## Rules
//
// Thirteen rules scan the renderer source tree:
//
//   focus-ring-removed     `focus:outline-none` with no focus-visible ring on
//                          the same element ("Accessibility": visible focus,
//                          never removed). A `focus:ring-*` does not count —
//                          "Selection and focus" puts the ring on
//                          `:focus-visible` and never on `:focus`.
//   focus-border-swap      a focus-scoped `border-*` — `focus:border-`,
//                          `focus-within:border-`, `focus-visible:border-`
//                          ("Selection and focus": ONE indicator, the shared
//                          ring). Recolouring the resting border instead is a
//                          second idiom, and a weaker one: it moves no pixels,
//                          so on a field whose border is already near the focus
//                          hue the change is invisible. The focus-ring sweep found it on
//                          whole form families (settings, the review door) and
//                          in the chat composer.
//   spacing-off-grid       arbitrary odd-pixel padding / margin / gap ("Space
//                          and size": every value comes from `sem.space.*`,
//                          a 2px grid — an odd number cannot be on it).
//   emoji-as-icon          emoji in source outside comments ("Reject on
//                          sight": decorative emoji as iconography).
//   selection-accent-bar   a `border-l-*` paired with `--accent-primary`
//                          ("Restraint": selection is neutral, no left bar).
//   backdrop-filter        `backdrop-blur` / `backdrop-filter` ("Motion":
//                          never on a scrim; it is also a ~10fps regression).
//                          Three sanctioned surfaces, all KIT SHELLS, through
//                          the `surface-glass` utility in the app CSS: the
//                          toast card (owner ruling 2026-09-04 — a
//                          corner-sized area), PointerPopover's opt-in
//                          `material="glass"` (owner ruling 2026-09-07, the
//                          conversation peek, drawn deliberately over a
//                          running terminal), Popover's opt-in of the same
//                          name (2026-09-08, the composer skill type-ahead,
//                          drawn over the transcript) and the command
//                          palette's shell (2026-09-10 — a dialog-scale area,
//                          affordable because the palette holds the terminal
//                          repaint pause for its lifetime, so the backdrop is
//                          blurred once and sits still; the SCRIM behind it
//                          stays a plain tone). One scrim blurs, through the
//                          `scrim-glass` utility: the palette's own, while it
//                          covers a conversation and no terminal (owner ruling
//                          2026-10-21). Any other blur, and any other consumer
//                          of either utility — a product file included — is
//                          flagged: a surface that wants glass asks the shell
//                          for it.
//   shadow-in-flow         a Tailwind `shadow-{sm,md,lg,xl,2xl}` utility
//                          ("Hairlines carry the structure": elevation is a
//                          three-step overlay ramp taken from the shadow
//                          tokens, so the utility is always the wrong reach).
//                          The in-flow exceptions are the primary action's
//                          faint highlight and a segmented control's thumb,
//                          and they reach for the `.control-raised` /
//                          `.control-thumb` classes, not for a utility.
//   arbitrary-z-index      `z-[n]` outside the layering scale ("Tokens or
//                          nothing": layering comes from `sem.z.*`).
//   accent-marks-active    an accent fill conditioned on active/selected
//                          ("The accent budget": solid accent is the primary
//                          action and nothing else).
//   uppercase-tracked      `uppercase` paired with a `tracking-*` utility
//                          ("Type": no uppercase letter-spaced labels as
//                          hierarchy).
//   hover-without-focus    `group-hover:opacity-100` with no focus counterpart
//                          ("Progressive disclosure": hover-only is a bug).
//   marketing-radii        `rounded-2xl` and up on operational chrome ("Space
//                          and size").
//   micro-type-floor       a text size below the 10px micro floor
//                          ("Restraint": density never comes from shrinking
//                          type).
//
// Two rules read the token layer instead of the component tree:
//
//   flexlayout-scoped-var  `var(--color-N)` outside `.flexlayout__layout`
//                          (the only block that defines it — elsewhere the
//                          border resolves to `currentColor`; audit 2026-09-02).
//   weight-off-ramp        `font-bold` / `font-extrabold` / `font-black` ("Type":
//                          the weight ramp is regular / medium / emphasis).
//   named-z-off-ladder     a Tailwind numeric `z-N` other than `z-0` / `z-10`,
//                          or a `z-[var(--…)]` naming a step the ladder does
//                          not declare ("Tokens or nothing": layering comes
//                          from `sem.z.*`; the in-flow steps are `--z-pane` /
//                          `--z-float`). A misspelt ladder name resolves to
//                          nothing and the element paints at `z-index: auto`,
//                          which is invisible in review and in the diff — the
//                          names are read from the bundle and from the app's
//                          own `--z-*` aliases, never typed here.
//   spacing-off-scale      a named Tailwind padding / margin / gap step whose
//                          pixel value is not on `sem.space.*` (14px `*-3.5`,
//                          28px `*-7`, 36px `*-9`, …). An indent that aligns
//                          text to a reserved glyph slot is structure, not
//                          rhythm: keep it with a `design-tokens-allow:` reason.
//   radius-off-ramp        `rounded-[Npx]` with N off the 3 / 7 / 9 ramp,
//                          and `rounded-xl` (12px) — the axes ratchet excludes
//                          explicit values, so this is the rule that sees them.
//   disabled-ink-copy      `text-[color:var(--text-disabled)]` on a prose
//                          element — `p`, `h1`-`h6`, `dt`, `label`, `legend`,
//                          `figcaption`, `caption`, `summary`, and nothing else
//                          — that is not itself disabled ("Accessibility":
//                          disabled ink never carries copy; the ramp certifies
//                          it to 3:1 non-text contrast only). `span`, `div` and
//                          `dd` are deliberately OUT of the set: in this tree a
//                          `span` or `div` in disabled ink is as often a
//                          separator, a timestamp or a placeholder-shaped hint
//                          as it is a sentence, and the audit ruled those ~117
//                          sites one at a time rather than by tag name. The
//                          elements listed above are prose by construction, so
//                          the rule decides them mechanically. Widening to
//                          `span`/`div` is a follow-up that needs its own
//                          per-site pass, not a regex edit.
//   focus-ring-missing     a `<button>`, `<summary>`, an `<a href>` or a
//                          `tabIndex={0}` element with an interactive `role`
//                          whose resolvable class list carries no focus-visible
//                          ring at all — the UA outline, which the system cannot
//                          theme. Class lists the guard cannot resolve (a `cn(…)`
//                          call, a prop passthrough, a spread) are skipped, never
//                          guessed.
//   app-token-restates-bundle  the mapping between `index.css` and
//                              `design-system/foundations/tokens.css`, policed
//                              four ways. The bundle is the authority
//                              (`design-system/USAGE.md`); the app must alias
//                              it, not mirror it by hand. In the base dark and
//                              light blocks — the only two permitted to alias,
//                              because they ARE the bundle's two modes — a
//                              mapped variable must alias its own counterpart:
//                              a literal restates or drifts from the bundle,
//                              and an alias to some *other* `--sem-*` is the
//                              one error a hand-written mapping is most likely
//                              to carry. In any other `:root`-family block a
//                              mapped variable is a violation whatever its
//                              value: a bare or attribute-conditional `:root`
//                              declaring one wins the cascade for every theme
//                              that does not declare it itself (18 of 19), and
//                              a theme block cannot alias at all because the
//                              bundle mode it would resolve against is
//                              whichever one is active. A theme block's own
//                              literals are the design and stay untouched.
//                              And anywhere in `index.css`, a `var(--sem-…)`
//                              naming a token the bundle does not declare: a
//                              retired token leaves every alias to it
//                              resolving to nothing, which paints as the
//                              property's initial value (a shadow as `none`)
//                              and reads in review as a deliberate choice.
//   theme-ramp-contrast        per theme: the ink ramp strong → default →
//                              muted → subtle → disabled must not invert, and
//                              `--text-disabled` must clear 3:1 against every
//                              surface it is painted on — `--bg-surface`,
//                              `--bg-surface-raised` and `--bg-app`
//                              ("Accessibility": the ink ramp orders
//                              identically in both modes). Raised chrome is
//                              where disabled ink most often lands (the CLI
//                              listbox, the command palette, the confirm
//                              dialog), so measuring the app canvas alone
//                              certifies a floor the product does not meet.
//
// ## Tolerance
//
// None, with one scoped and self-terminating exception:
// `scripts/design-system-conformance/disabled-contrast.json` lists
// `"<theme>:<surface>"` pairings already known to miss the 3:1 disabled floor,
// so the measurement can land ahead of the nineteen-theme retone that clears
// it. It is not a general baseline: it tolerates only this one check, an entry
// whose pairing now clears the floor is itself an error, and a missing or empty
// file means zero tolerance. The file exists to be emptied and deleted.
//
// Every other rule sweeps clean and carries no tolerance at all: one violation
// fails `npm run lint`. The per-rule baseline files that let the twelve fix
// tasks land one at a time were deleted once the last of them emptied — a
// tolerance file that is only ever empty is a place for a regression to be
// parked, not a safety net.
//
// A genuine exception is documented on the line, not in a list.
//
// ## Exemptions
//
// A `design-tokens-allow: <reason>` marker suppresses a violation on its own
// line or on one of the two following lines — mirroring the `design-tokens-allow`
// convention, and the same reach it has in `lint-design-tokens.mjs`. The marker
// is per-line: there is no block or per-file form. A marker with no reason text
// is itself an error.
//
// ## Usage
//
//   node scripts/lint-design-system-conformance.mjs
//   node scripts/lint-design-system-conformance.mjs --report        # never fails
//   node scripts/lint-design-system-conformance.mjs --quiet

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const SOURCE_ROOT = 'src/renderer/src'
const APP_CSS_PATH = 'src/renderer/src/assets/index.css'
const BUNDLE_CSS_PATH = 'design-system/foundations/tokens.css'
const TOKENS_JSON_PATH = 'design-system/foundations/tokens.tokens.json'
const DISABLED_CONTRAST_BASELINE_PATH = 'scripts/design-system-conformance/disabled-contrast.json'

const SOURCE_EXT = new Set(['.tsx', '.ts'])
// Review-only surfaces. `design-system/` is never scanned at all: the bundle
// legitimately declares the values the app must not restate.
const EXCLUDED_DIRS = new Set(['__preview__'])

const ALLOW_MARKER = 'design-tokens-allow:'

const repoRoot = process.cwd()

/* ------------------------------------------------------------------ *
 * Bundle-derived numbers
 * ------------------------------------------------------------------ */

// The rules below carry numeric floors that are bundle values. Read them from
// the bundle's own source rather than typing them in again: a second copy of a
// token value with nothing keeping it in sync is the drift this guard exists to
// catch, and the guard must not be the thing that drifts.
function readTokenDimensionPx(tokens, path) {
  let node = tokens
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return null
    node = node[key]
  }
  const declared = node?.$value
  if (typeof declared !== 'string') return null
  const px = declared.match(/^(\d+(?:\.\d+)?)px$/)
  return px ? Number(px[1]) : null
}

// The `sem.radius.*` steps allowed to stand outside the ramp, by name: the
// composer's box and the strip tucked under it (owner ruling 2026-10-04), and
// the cards set against it (owner ruling 2026-10-05). The list is here, not
// only in the bundle, so the exception stays exactly these three: a step the list does not name that marks itself `offRamp` is refused
// (exit 2) rather than skipped, or the flag would let any radius past the
// ceiling.
const OFF_RAMP_RADIUS_STEPS = new Set(['composer', 'composer-strip', 'composer-companion'])

// Whether a `sem.radius.*` step is a named exception rather than a rung of the
// ramp: its metadata carries `offRamp: true` (see readBundleDimensions).
function radiusStepIsOffRamp(tokens, step) {
  return tokens?.sem?.radius?.[step]?.$extensions?.['com.sprintengine']?.offRamp === true
}

function readBundleDimensions() {
  const abs = resolve(repoRoot, TOKENS_JSON_PATH)
  if (!existsSync(abs)) {
    process.stderr.write(`Missing ${TOKENS_JSON_PATH}. Run this from the repo root.\n`)
    process.exit(2)
  }
  let tokens
  try {
    tokens = JSON.parse(readFileSync(abs, 'utf8'))
  } catch {
    process.stderr.write(`${TOKENS_JSON_PATH} is not valid JSON.\n`)
    process.exit(2)
  }
  // The layering ladder, by name. `sem.z.*` is the ladder the bundle declares;
  // the app's `--z-*` aliases in index.css are the names markup actually
  // writes, and both are read rather than listed here for the same reason every
  // other number in this guard is: a second copy with nothing keeping it in
  // sync is the drift the guard exists to catch.
  const zLadderNames = new Set()
  for (const step of Object.keys(tokens?.sem?.z ?? {})) {
    if (step.startsWith('$')) continue
    zLadderNames.add(`--sem-z-${step}`)
  }
  const appCssForZ = resolve(repoRoot, APP_CSS_PATH)
  if (existsSync(appCssForZ)) {
    // Declarations only (`--z-pane:`), never a `var(--z-pane)` usage.
    for (const alias of readFileSync(appCssForZ, 'utf8').matchAll(/(--z-[\w-]+)\s*:/g)) {
      zLadderNames.add(alias[1])
    }
  }
  if (zLadderNames.size === 0) {
    process.stderr.write(
      `${TOKENS_JSON_PATH} declares no sem.z.* ladder and ${APP_CSS_PATH} declares no --z-* ` +
        'aliases: named-z-off-ladder would have no ladder to check names against.\n',
    )
    process.exit(2)
  }
  const microFontSizePx = readTokenDimensionPx(tokens, 'sem.font.size.micro')
  // `$`-prefixed keys are DTCG metadata on the group itself, not steps of it.
  // `pill` is excluded because it is an IDIOM, not a rung: 999px fully-rounded
  // ends, for a badge or a switch track. It is the same exclusion this file
  // already makes for `rounded-full` in MARKETING_RADIUS, and it has to be made
  // here too — left in, its 999px becomes `largestRadiusPx` and trips the
  // marketing-floor assertion below, failing the build on a token the system
  // deliberately declares. It must also stay out of `radiusStepsPx`, or
  // `rounded-[999px]` would silently become an on-ramp spelling.
  //
  // A step whose metadata says `offRamp: true` is excluded for the same
  // reason: a named exception to the ceiling, not a rung — the composer's 22px
  // box and its 16px strip (owner ruling 2026-10-04). The app reaches them by
  // their variable, never by a `rounded-[Npx]` the ramp check would read.
  const strayOffRamp = Object.keys(tokens?.sem?.radius ?? {}).filter(
    (step) => !step.startsWith('$') && radiusStepIsOffRamp(tokens, step) && !OFF_RAMP_RADIUS_STEPS.has(step),
  )
  if (strayOffRamp.length > 0) {
    process.stderr.write(
      `${TOKENS_JSON_PATH}: ${strayOffRamp.map((step) => `sem.radius.${step}`).join(', ')} is marked offRamp, ` +
        `but the only named exceptions to the radius ceiling are ${[...OFF_RAMP_RADIUS_STEPS].join(' and ')}. ` +
        'A new one is an owner ruling and an edit to OFF_RAMP_RADIUS_STEPS, not a flag.\n',
    )
    process.exit(2)
  }
  const radiusSteps = Object.keys(tokens?.sem?.radius ?? {})
    .filter((step) => !step.startsWith('$') && step !== 'pill' && !radiusStepIsOffRamp(tokens, step))
    .map((step) => readTokenDimensionPx(tokens, `sem.radius.${step}`))
    .filter((value) => value !== null)
  if (microFontSizePx === null || radiusSteps.length === 0) {
    process.stderr.write(`${TOKENS_JSON_PATH} must declare sem.font.size.micro and sem.radius.* as px dimensions.\n`)
    process.exit(2)
  }
  return {
    microFontSizePx,
    largestRadiusPx: Math.max(...radiusSteps),
    radiusStepsPx: radiusSteps,
    zLadderNames,
  }
}

const bundleDimensions = readBundleDimensions()

/* ------------------------------------------------------------------ *
 * Lexing helpers
 * ------------------------------------------------------------------ */

const KIND_CODE = 0
const KIND_COMMENT = 1
const KIND_STRING = 2
const KIND_REGEX = 3

// Words after which a `/` opens a regex literal rather than dividing.
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
])

const IDENT_CHAR = /[\w$]/

// End offset (exclusive, flags included) of a regex literal opening at
// `start`, or -1 when it does not close on the same line. A regex literal
// cannot span a newline, so bailing there bounds the damage of a `/` the
// heuristic below reads wrong to a single line.
function regexLiteralEnd(source, start) {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\n') return -1
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      i += 1
      while (i < source.length && /[dgimsuvy]/.test(source[i])) i += 1
      return i
    }
    i += 1
  }
  return -1
}

// Classify every offset as code, comment, string body, or regex body. Template
// interpolations (`${…}`) are code, so a class context built from a template
// literal still sees the identifiers spliced into it.
//
// Regex literals are their own kind because their bodies read as markup: the
// pattern `/<button[^>]*type="button"[^>]*>Logic<\/button>/` is a string
// describing a button, not a button, and reading it as an opening tag invented
// a `focus-ring-missing` finding on it (audit 2026-09-02). A production file
// carrying such a pattern would ship a red lint for markup it does not render.
// Regex bodies are tracked only at the top level of the file; a regex written
// inside a `${…}` interpolation is rare enough to leave to the template walker.
function classifySource(source) {
  const kinds = new Uint8Array(source.length)
  // Stack of template-literal depths so `${ `nested` }` unwinds correctly.
  const templateStack = []
  let i = 0
  // Last significant (non-whitespace) code character, the one before it, and
  // the identifier that ended at it — enough to tell a regex literal from a
  // division without a real parser.
  let prev = ''
  let prevPrev = ''
  let prevWord = ''
  const settle = (ch, word = '') => {
    prevPrev = prev
    prev = ch
    prevWord = word
  }
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      kinds.fill(KIND_COMMENT, i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      kinds.fill(KIND_COMMENT, i, stop)
      i = stop
      continue
    }
    if (ch === "'" || ch === '"') {
      const start = i
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === ch || source[i] === '\n') break
        i += 1
      }
      const stop = Math.min(source.length, i + 1)
      kinds.fill(KIND_STRING, start + 1, Math.max(start + 1, stop - 1))
      i = stop
      settle(ch)
      continue
    }
    if (ch === '`') {
      i = scanTemplate(source, i, kinds, templateStack)
      settle('`')
      continue
    }
    if (ch === '/') {
      let opensRegex
      if (prev === '') opensRegex = true
      else if (IDENT_CHAR.test(prev)) opensRegex = REGEX_AFTER_KEYWORD.has(prevWord)
      else if (prev === ')' || prev === ']' || prev === '}') opensRegex = false
      else if (prev === '"' || prev === "'" || prev === '`' || prev === '/') opensRegex = false
      // `=>` opens one; a bare `>` closes a JSX tag, after which a `/` is text.
      else if (prev === '>') opensRegex = prevPrev === '='
      // `</` is a JSX closing tag, never a regex.
      else if (prev === '<') opensRegex = false
      else opensRegex = true
      const end = opensRegex ? regexLiteralEnd(source, i) : -1
      if (end > 0) {
        kinds.fill(KIND_REGEX, i, end)
        i = end
        settle('/')
        continue
      }
      settle('/')
      i += 1
      continue
    }
    if (IDENT_CHAR.test(ch)) {
      const start = i
      while (i < source.length && IDENT_CHAR.test(source[i])) i += 1
      const word = source.slice(start, i)
      settle(word[word.length - 1], word)
      continue
    }
    if (!/\s/.test(ch)) settle(ch)
    i += 1
  }
  return kinds
}

// Walk a template literal from its opening backtick, marking the literal
// segments as string and leaving `${…}` interpolations as code.
function scanTemplate(source, openIndex, kinds, templateStack) {
  let i = openIndex + 1
  let segmentStart = i
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') {
      kinds.fill(KIND_STRING, segmentStart, i)
      return i + 1
    }
    if (ch === '$' && source[i + 1] === '{') {
      kinds.fill(KIND_STRING, segmentStart, i)
      templateStack.push(1)
      i += 2
      let depth = 1
      while (i < source.length && depth > 0) {
        const inner = source[i]
        if (inner === '{') depth += 1
        else if (inner === '}') depth -= 1
        else if (inner === '`') {
          i = scanTemplate(source, i, kinds, templateStack)
          continue
        } else if (inner === "'" || inner === '"') {
          const quote = inner
          const start = i
          i += 1
          while (i < source.length) {
            if (source[i] === '\\') {
              i += 2
              continue
            }
            if (source[i] === quote || source[i] === '\n') break
            i += 1
          }
          kinds.fill(KIND_STRING, start + 1, Math.min(source.length, i))
          i = Math.min(source.length, i + 1)
          continue
        }
        i += 1
      }
      templateStack.pop()
      segmentStart = i
      continue
    }
    i += 1
  }
  kinds.fill(KIND_STRING, segmentStart, source.length)
  return source.length
}

function lineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineOf(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/* ------------------------------------------------------------------ *
 * Class-context resolution
 * ------------------------------------------------------------------ */

// End offset of a JSX opening tag started at `open`, or -1. Quotes and brace
// depth are respected so `className={cn('a > b')}` does not close the tag.
function openingTagEnd(source, open, kinds) {
  let depth = 0
  for (let i = open + 1; i < source.length && i - open < 6000; i += 1) {
    if (kinds[i] !== KIND_CODE) continue
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    else if (ch === '<' && depth === 0) return -1
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

// Innermost JSX opening tag containing `index`, as text.
function enclosingOpeningTag(source, index, kinds) {
  const floor = Math.max(0, index - 4000)
  for (let i = Math.min(index, source.length - 1); i >= floor; i -= 1) {
    if (source[i] !== '<') continue
    if (kinds[i] !== KIND_CODE) continue
    const nextChar = source[i + 1]
    if (!nextChar || !/[A-Za-z_]/.test(nextChar)) continue
    const end = openingTagEnd(source, i, kinds)
    if (end > index) return source.slice(i, end + 1)
  }
  return null
}

const OPENERS = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = { ')': '(', ']': '[', '}': '{' }

// Innermost balanced (…)/[…]/{…} group containing `index` whose span fits
// `maxSpan`, as text. This is what catches class lists built as arrays or
// `cn(…)` calls rather than written inline on the element.
function enclosingGroup(source, index, kinds, maxSpan) {
  const floor = Math.max(0, index - maxSpan)
  const pending = []
  for (let i = index; i >= floor; i -= 1) {
    if (kinds[i] !== KIND_CODE) continue
    const ch = source[i]
    if (CLOSERS[ch] && i !== index) {
      pending.push(CLOSERS[ch])
      continue
    }
    if (!OPENERS[ch]) continue
    if (pending.length > 0 && pending[pending.length - 1] === ch) {
      pending.pop()
      continue
    }
    if (pending.length > 0) continue
    const end = matchingClose(source, i, kinds, maxSpan)
    if (end > index) return source.slice(i, end + 1)
    return null
  }
  return null
}

function matchingClose(source, open, kinds, maxSpan) {
  const want = OPENERS[source[open]]
  let depth = 0
  for (let i = open; i < source.length && i - open <= maxSpan; i += 1) {
    if (kinds[i] !== KIND_CODE) continue
    const ch = source[i]
    if (OPENERS[ch]) depth += 1
    else if (CLOSERS[ch]) {
      depth -= 1
      if (depth === 0) return ch === want ? i : -1
    }
  }
  return -1
}

// Text of the string or template segment containing `index`.
function enclosingLiteral(source, index, kinds) {
  if (kinds[index] !== KIND_STRING) return null
  let start = index
  while (start > 0 && kinds[start - 1] === KIND_STRING) start -= 1
  let end = index
  while (end < source.length - 1 && kinds[end + 1] === KIND_STRING) end += 1
  return source.slice(start, end + 1)
}

// The text a "same element" rule reasons over: the enclosing JSX opening tag,
// the enclosing bracket group, and the enclosing string literal, concatenated.
// A rule asking "is a ring declared alongside this?" wants all three, because
// class lists are written in all three shapes across this tree.
function classContext(file, index, maxSpan) {
  const parts = []
  const tag = enclosingOpeningTag(file.source, index, file.kinds)
  if (tag && tag.length <= maxSpan * 2) parts.push(tag)
  const group = enclosingGroup(file.source, index, file.kinds, maxSpan)
  if (group) parts.push(group)
  const literal = enclosingLiteral(file.source, index, file.kinds)
  if (literal) parts.push(literal)
  parts.push(file.lines[lineOf(file.starts, index) - 1] ?? '')
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * Source rules
 * ------------------------------------------------------------------ */

const FOCUS_OUTLINE_NONE = /(?<![\w-])focus:outline-none(?![\w-])/g
// Only a `:focus-visible` indicator satisfies the clause. A `focus:ring-*` draws
// on mouse click, which the same paragraph rules out ("Never on `:focus` — a
// mouse click must not draw a ring"), so it does not discharge the outline.
// `focus-ring` is the shared utility (assets/index.css), named for markup by
// FOCUS_RING_CLASS and its siblings in components/ui/tokens.ts.
const FOCUS_RING_PRESENT =
  /focus-visible:(?:focus-ring|ring|shadow|outline|border)|has-\[[^\]]*\]:focus-ring|terminal-focus-ring|FOCUS_RING_(?:CLASS|INSET_CLASS|PEER_CLASS|WITHIN_INPUT_CLASS|WITHIN_TEXTAREA_CLASS|TERMINAL_CLASS)/

const SPACING_ARBITRARY =
  /(?<![\w-])-?(?:px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m|gap-x|gap-y|gap|space-x|space-y)-\[(-?\d+(?:\.\d+)?)px\]/g

// Emoji proper, plus the two symbol blocks the tree actually reaches for when
// it draws an icon with a character — Miscellaneous Symbols (⚠, ⏺) and
// Dingbats (✓, ✗, ✳). Arrows, box drawing, and geometric shapes are NOT here:
// they are typographic marks the system permits, not iconography.
// A focus-scoped border recolour, in every variant form the tree spells it.
// `border-` and not `border-b`/`border-l` alone: the shape a swap takes is
// always a colour on some edge, and the rule wants all of them.
const FOCUS_BORDER_SWAP = /(?<![\w-])(?:group-|peer-)?focus(?:-within|-visible)?:border-/g

const EMOJI = /[\p{Extended_Pictographic}☀-⛿✀-➿]/gu
const EMOJI_ALLOWED = new Set(['©', '®', '™'])

// A left bar in the accent is the violation itself; the bare `border-…` form
// is one only when a left-border width sits in the same class context, which
// is how `InboxRow` splits the two halves across a class array.
const ACCENT_LEFT_BORDER = /(?<![\w-])border-l-\[(?:color:)?var\(--accent-primary\)\]/g
const ACCENT_BORDER = /(?<![\w-])border-\[(?:color:)?var\(--accent-primary\)\]/g
const LEFT_BORDER_WIDTH = /(?<![\w-])border-l(?:-(?:0|2|4|8|\[\d+(?:\.\d+)?(?:px|rem)?\]))?(?![\w-])/

const BACKDROP_FILTER = /(?<![\w-])backdrop-(?:blur|filter)(?:-[\w.[\]/-]+)?/g
// Glass is the kit's alone: the utility that carries the blur, and the shells
// allowed to wear it. Everything else that blurs — or borrows the class — is a
// `backdrop-filter` violation.
const GLASS_UTILITY = 'surface-glass'
const GLASS_UTILITY_PATTERN = /(?<![\w-])surface-glass(?![\w-])/g
// The kit shells the owner has sanctioned, and nothing else. Widened from
// Toast.tsx alone by the owner ruling of 2026-09-07 (the conversation peek);
// `design-system/components/toast/component.md` carries the amended ruling and
// says plainly that the peek is the larger area, rather than pretending the
// 2026-09-04 area argument still covers it. Popover.tsx joined on 2026-09-08:
// the popover spec's "Material" section already ruled glass an opt-in material
// of the whole popover family, and the anchored shell is that family's engine —
// the composer skill type-ahead is its first glass consumer. CommandPalette.tsx
// joined on 2026-09-10: the first dialog-scale glass, and the first over the
// middle of the window where the terminals are — which is why it is paired
// with the terminal repaint pause (`terminalRepaintPause.ts`, the hold `Modal`
// takes): the ~10fps measurement was a blur re-sampled on every PTY chunk, and
// a blur over paused panes is computed once. The scrim behind it is still a
// plain tone. A product file that wants glass asks one of these shells for it.
const GLASS_CONSUMER_FILES = new Set([
  'src/renderer/src/components/ui/Toast.tsx',
  'src/renderer/src/components/ui/PointerPopover.tsx',
  'src/renderer/src/components/ui/Popover.tsx',
  'src/renderer/src/components/ui/CommandPalette.tsx',
])
// The scrim's glass: the command palette's scrim alone, and only over a
// conversation (owner ruling 2026-10-21). The ~10fps measurement was a blur
// over streaming terminals, so the palette asks `paletteBackdropIsConversation`
// and keeps the plain tone whenever a terminal is in view.
const SCRIM_GLASS_UTILITY = 'scrim-glass'
const SCRIM_GLASS_UTILITY_PATTERN = /(?<![\w-])scrim-glass(?![\w-])/g
const SCRIM_GLASS_CONSUMER_FILES = new Set(['src/renderer/src/components/ui/CommandPalette.tsx'])

const TAILWIND_SHADOW = /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl)(?![\w-])/g

const ARBITRARY_Z = /(?<![\w-])z-\[([^\]]+)\]/g

const ACCENT_FILL = /(?<![\w-])bg-\[(?:color:)?var\(--accent-primary(?:-soft(?:-strong)?)?\)\]/g
// An identifier, not a fragment of a token name: `--bg-active` and
// `aria-selected` must not read as "this marks the active thing".
const ACTIVE_CONDITION = /(?<![\w$-])(?:is|Is)?(?:active|Active|selected|Selected|current|Current)(?![\w-])/
const HAIRLINE_SHAPE = /(?<![\w-])(?:h-px|w-px|h-0\.5|w-0\.5)(?![\w-])/

const UPPERCASE = /(?<![\w-])uppercase(?![\w-])/g
const TRACKING = /(?<![\w-])tracking-/

const GROUP_HOVER_REVEAL = /(?<![\w-])group-hover:opacity-100(?![\w-])/g
const FOCUS_REVEAL = /(?:group-)?focus(?:-within|-visible)?:opacity-100/

// `rounded-2xl` is 16px; the arbitrary form is caught at the same threshold, so
// spelling `rounded-2xl` as `rounded-[16px]` does not evade the rule.
// `rounded-full` is deliberately absent: a pill or a dot is its own idiom, not
// a marketing radius.
//
// 16px is a Tailwind step, not a bundle value — the system's shape scale tops
// out at `sem.radius.shell` (9px). The threshold tracks the named utilities
// rather than the scale because the two must agree: dropping it to the scale
// would fail `rounded-[10px]` while `rounded-xl` (12px, a named step this rule
// does not list) still passed. Closing that band is a rule change, not a floor
// change. What IS read from the bundle is the assertion below: if the system
// ever declares a radius that reaches the marketing floor, this rule would fire
// on the system's own chrome, and it says so instead of drifting.
const MARKETING_RADIUS = /(?<![\w-])rounded-(?:2xl|3xl|4xl|\[(\d+(?:\.\d+)?)px\])(?![\w-])/g
const MARKETING_RADIUS_FLOOR_PX = 16

if (bundleDimensions.largestRadiusPx >= MARKETING_RADIUS_FLOOR_PX) {
  process.stderr.write(
    `${TOKENS_JSON_PATH} declares a ${bundleDimensions.largestRadiusPx}px radius, at or above the ` +
      `${MARKETING_RADIUS_FLOOR_PX}px marketing floor: the marketing-radii rule would fail the ` +
      'shape scale the system itself declares. Revisit the rule, not the bundle.\n',
  )
  process.exit(2)
}

// The micro floor: `sem.font.size.micro` is the smallest step the system
// declares, and anything under it is type shrunk to fit a container.
const TEXT_SIZE = /(?<![\w-])text-\[(\d+(?:\.\d+)?)px\]/g
const MICRO_FLOOR_PX = bundleDimensions.microFontSizePx

// ── Rules added by the 2026-09-02 audit ────────────────────────────────

const FLEXLAYOUT_SCOPED_VAR = /var\(--color-[1-6]\)/g

const WEIGHT_OFF_RAMP = /(?<![\w-])font-(?:bold|extrabold|black)(?![\w-])/g

const NAMED_Z = /(?<![\w-])-?z-(\d+)(?![\w.[-])/g
const NAMED_Z_ALLOWED = new Set([0, 10])
// `z-[var(--z-pane)]` and `z-[var(--sem-z-modal)]` are the two spellings markup
// uses. The NAME inside is the whole point of the token: `--z-bogus` resolves to
// nothing, so the element paints at `z-index: auto` and the layering silently
// becomes DOM order. Anything that is not a bare ladder var — a raw number, a
// `calc()`, a fallback — stays with `arbitrary-z-index`, whose fix hint is the
// scale itself.
const LADDER_Z_VAR = /^var\((--(?:sem-)?z-[\w-]+)\)$/
const Z_LADDER_NAMES = bundleDimensions.zLadderNames

// Tailwind's named step × 4 = px. On-scale steps map to 2/4/6/8/10/12/16/20/24/32.
const SPACING_NAMED =
  /(?<![\w-])-?(?:px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m|gap-x|gap-y|gap|space-x|space-y)-(\d+(?:\.\d+)?)(?![\w.[-])/g
const SPACING_STEPS_ON_SCALE = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8])

const RADIUS_ARBITRARY = /(?<![\w-])rounded(?:-(?:[tblr]|[tb][lr]|ss|se|es|ee))?-\[(\d+(?:\.\d+)?)px\]/g
const RADIUS_XL = /(?<![\w-])rounded(?:-(?:[tblr]|[tb][lr]))?-xl(?![\w-])/g
const RADIUS_STEPS_PX = new Set(bundleDimensions.radiusStepsPx)

// The bare utility only: `placeholder:`, `disabled:`, `hover:` and every other
// variant prefix ends in `:` and is excluded by the look-behind.
const DISABLED_INK = /(?<![\w:-])text-\[(?:color:)?var\(--text-disabled\)\]/g
// Sentences and headings only — `p`, `h1`-`h6`, `dt`, `label`, `legend`,
// `figcaption`, `caption`, `summary`, and nothing else. A `span`/`div`/`dd` in
// disabled ink is as often a separator, a timestamp or a placeholder-shaped
// hint as it is copy, and the audit ruled those ~117 sites per site; the
// elements below are prose by construction, so the rule can decide them by tag.
// Widening this to `span`/`div` is a follow-up that needs its own per-site pass.
const TEXT_ELEMENT_TAG = /^<(?:p|h[1-6]|dt|label|legend|figcaption|caption|summary)\b/
// Attribute position only: `--text-disabled` inside a class string must not read
// as the element being disabled.
const ELEMENT_DISABLED = /(?<=\s)(?:disabled|aria-disabled)(?=[\s=/>])/

// Start index of the innermost JSX opening tag containing `index`, or -1.
function enclosingOpeningTagStart(source, index, kinds) {
  const floor = Math.max(0, index - 4000)
  for (let i = Math.min(index, source.length - 1); i >= floor; i -= 1) {
    if (source[i] !== '<') continue
    if (kinds[i] !== KIND_CODE) continue
    const nextChar = source[i + 1]
    if (!nextChar || !/[A-Za-z_]/.test(nextChar)) continue
    const end = openingTagEnd(source, i, kinds)
    if (end > index) return i
  }
  return -1
}

const INTERACTIVE_ROLE =
  /\brole=["'](?:button|option|menuitem|menuitemradio|menuitemcheckbox|tab|checkbox|radio|switch|link)["']/g
const NATIVE_FOCUSABLE_OPEN = /<(?:button|summary|a)\b/g
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'void'])
const CONDITION_FOLLOWS = /^\s*(?:\?|&&|\|\||===|!==|==|!=|>=|<=|>|<|\)|\]|,|:)/

// The value expression of `className=` inside an opening tag, as `{ text,
// offset }` with the offset tag-relative.
//
// The two ways this returns nothing are different facts and the caller must
// not conflate them: `{ absent: true }` means the tag declares no className at
// all, which resolves the class list to the empty list — a real verdict.
// `{ unparseable: true }` means a className is declared and this reader could
// not extract it, which resolves nothing. Collapsing both to null made the
// second fall through to 'none' and FLAG, so `<button className={'{'}>Go</button>`
// was reported as ringless on a class list the guard never read — the opposite
// of this rule's "skipped, never guessed" promise (audit 2026-09-02).
function classNameExpression(tag) {
  const at = tag.search(/\bclassName=/)
  if (at < 0) return { absent: true }
  let i = at + 'className='.length
  const ch = tag[i]
  if (ch === '"' || ch === "'") {
    const close = tag.indexOf(ch, i + 1)
    if (close < 0) return { unparseable: true }
    return { text: tag.slice(i, close + 1), offset: i }
  }
  if (ch === '{') {
    let depth = 0
    for (let j = i; j < tag.length; j += 1) {
      if (tag[j] === '{') depth += 1
      else if (tag[j] === '}') {
        depth -= 1
        if (depth === 0) return { text: tag.slice(i, j + 1), offset: i }
      }
    }
  }
  return { unparseable: true }
}

// End offset (exclusive) of the initialiser that starts at `start`, or -1.
// The statement ends at a `;` outside brackets, or at a newline that does not
// continue an expression — the multi-line `'a ' +\n  'b ' +\n  CONST` shape the
// kit writes its shared class strings in.
function initialiserEnd(file, start) {
  const { source, kinds } = file
  let depth = 0
  let prev = ''
  for (let i = start; i < source.length && i - start < 4000; i += 1) {
    // A comment is not a token: a `//` note between `+` and the next operand
    // must not read as the end of the expression.
    if (kinds[i] === KIND_COMMENT) continue
    if (kinds[i] !== KIND_CODE) {
      prev = 'x'
      continue
    }
    const ch = source[i]
    if (ch === '\n') {
      if (depth === 0 && !'+,([{=?:&|'.includes(prev)) return i
      continue
    }
    if (OPENERS[ch]) depth += 1
    else if (CLOSERS[ch]) {
      if (depth === 0) return i
      depth -= 1
    } else if (ch === ';' && depth === 0) return i
    if (!/\s/.test(ch)) prev = ch
  }
  return -1
}

// Every character an initialiser may carry once its string, comment and regex
// spans are blanked out: quotes, `+`, and the `${…}` punctuation of a template,
// plus identifier characters. A `(`, `.`, `?`, `:`, `,`, `[` — a call, a member
// access, a ternary, an array, an object — means the value is not a plain
// concatenation and this reader must not pretend to have read it.
const CONCATENATION_ONLY = /^[\s'"`+${}\w]*$/

// Resolve `const NAME = …` in the same file to the class text it contributes,
// or null when NAME is not a resolvable class constant here.
//
// The initialiser may be a string or template literal, or a `+` chain of them
// with other constants — the shape the kit uses to append a shared
// `FOCUS_RING_*` token to a base class string (`ui/SplitButton.tsx`'s `HALF`).
// Reading only the FIRST literal of such a chain reported a control that does
// wear the ring as ringless, so the whole chain is read or nothing is.
function resolveConstant(file, name, depth = 0) {
  if (depth > 2) return null
  // The name is spliced into a pattern, so escape it. Unescaped, the bare `$`
  // that a template className contributes as a candidate identifier became an
  // end-of-string anchor — `\bconst\s+$\s*=` matches nothing, ever — and every
  // template-literal class list in the tree resolved to `unresolved-ident` and
  // was skipped (audit 2026-09-02).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const decl = new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*`)
  const m = decl.exec(file.source)
  if (!m) return null
  const start = m.index + m[0].length
  const end = initialiserEnd(file, start)
  if (end < 0) return null

  const { source, kinds } = file
  let skeleton = ''
  for (let i = start; i < end; i += 1) {
    skeleton += kinds[i] === KIND_CODE ? source[i] : ' '
  }
  if (!CONCATENATION_ONLY.test(skeleton)) return null

  let out = ''
  let i = start
  while (i < end) {
    const kind = kinds[i]
    if (kind !== KIND_CODE) {
      if (kind === KIND_STRING) {
        const literal = enclosingLiteral(source, i, kinds)
        out += ' ' + literal
        i += literal.length
        continue
      }
      i += 1
      continue
    }
    const ch = source[i]
    if (/[A-Za-z_$]/.test(ch) && !(ch === '$' && source[i + 1] === '{')) {
      let j = i
      while (j < end && /[\w$]/.test(source[j])) j += 1
      const identifier = source.slice(i, j)
      // A shared ring token is evidence on its own; the caller's
      // FOCUS_RING_PRESENT names these by identifier as well as by class.
      if (identifier.startsWith('FOCUS_RING_')) out += ' ' + identifier
      else {
        const nested = resolveConstant(file, identifier, depth + 1)
        // One unreadable link makes the whole chain unreadable: returning the
        // rest would be reporting on a class list that was never assembled.
        if (nested === null) return null
        out += ' ' + nested
      }
      i = j
      continue
    }
    i += 1
  }
  return out
}

// Tag-relative offsets of the `{` that opens each SPREAD attribute of the tag
// — a `{` at the tag's own brace depth whose first content is `...`. An object
// spread nested inside another attribute's expression (`onClick={() =>
// f({ ...x })}`) is not one: it cannot contribute a className to the element.
function spreadAttributeOffsets(source, open, end, kinds) {
  const offsets = []
  let depth = 0
  for (let i = open + 1; i <= end; i += 1) {
    if (kinds[i] !== KIND_CODE) continue
    const ch = source[i]
    if (ch === '{') {
      if (depth === 0 && /^\{\s*\.\.\./.test(source.slice(i, i + 8))) offsets.push(i - open)
      depth += 1
    } else if (ch === '}') depth = Math.max(0, depth - 1)
  }
  return offsets
}

// Decide whether an opening tag at `open` carries a focus ring. Returns
// 'ring' | 'none' | 'unknown'.
function focusRingVerdict(file, open) {
  const { source, kinds } = file
  const end = openingTagEnd(source, open, kinds)
  if (end < 0) return 'unknown'
  const tag = source.slice(open, end + 1)
  if (/\btabIndex=\{\s*-1\s*\}/.test(tag)) return 'ring'
  // A spread attribute can carry a className the guard cannot see — but only
  // where JSX would let it win. Attributes apply left to right, so a `className`
  // written AFTER the last spread is the one that lands, and the spread tells
  // the class list nothing. Skipping on any spread at all silenced every
  // primitive in `ui/Buttons.tsx` (the kit controls whose ring this rule most
  // needs to police), because each spells `{...rest}` before its own className
  // precisely so a caller cannot override the ring (audit 2026-09-02).
  const spreads = spreadAttributeOffsets(source, open, end, kinds)
  if (spreads.length > 0) {
    const classNameAt = tag.search(/\bclassName=/)
    if (classNameAt < 0 || spreads[spreads.length - 1] > classNameAt) return 'unknown'
  }
  if (/^<a\b/.test(tag) && !/\bhref=/.test(tag)) return 'unknown'
  if (FOCUS_RING_PRESENT.test(tag)) return 'ring'
  const expr = classNameExpression(tag)
  // No className at all is a resolved empty class list, and an empty class list
  // has no ring. A className this reader could not parse is resolved nothing.
  if (expr.absent) return 'none'
  if (expr.unparseable) return 'unknown'
  const base = open + expr.offset
  // Split the expression into literal text and code text using the source kinds.
  let literalText = ''
  let codeText = ''
  for (let i = 0; i < expr.text.length; i += 1) {
    const kind = kinds[base + i]
    if (kind === KIND_STRING) literalText += expr.text[i]
    else if (kind === KIND_CODE) codeText += expr.text[i]
    else codeText += ' '
  }
  if (FOCUS_RING_PRESENT.test(literalText)) return 'ring'
  // A call, member access or prop passthrough makes the list unresolvable.
  if (/[A-Za-z_$][\w$]*\s*\(/.test(codeText) || /\.\s*[A-Za-z_$]/.test(codeText)) return 'unknown'
  if (/\bclassName\b/.test(codeText)) return 'unknown'
  let resolved = ''
  const identifiers = codeText.matchAll(/[A-Za-z_$][\w$]*/g)
  for (const found of identifiers) {
    const name = found[0]
    // `${` in a template className leaves a bare `$` at code position. It is
    // punctuation opening an interpolation, not an identifier; the name inside
    // the interpolation is matched on its own pass.
    if (/^\$+$/.test(name)) continue
    if (KEYWORDS.has(name)) continue
    if (name.startsWith('FOCUS_RING_')) return 'ring'
    const value = resolveConstant(file, name)
    if (value !== null) {
      resolved += '\n' + value
      continue
    }
    // An identifier that only steers a ternary contributes no classes itself.
    const after = codeText.slice(found.index + name.length)
    if (CONDITION_FOLLOWS.test(after)) continue
    return 'unknown'
  }
  if (FOCUS_RING_PRESENT.test(resolved)) return 'ring'
  return 'none'
}

function scanFocusRingMissing(file, push) {
  const { source, kinds } = file
  const seen = new Set()
  const visit = (open, label) => {
    if (open < 0 || seen.has(open)) return
    seen.add(open)
    if (kinds[open] !== KIND_CODE) return
    if (focusRingVerdict(file, open) !== 'none') return
    const tagName = (source.slice(open, open + 40).match(/^<([\w.]+)/) || [])[1] ?? 'element'
    push('focus-ring-missing', file, open, `<${tagName} …> ${label}`)
  }
  forEachMatch(NATIVE_FOCUSABLE_OPEN, source, (match) => visit(match.index, 'has no focus-visible ring'))
  forEachMatch(INTERACTIVE_ROLE, source, (match) => {
    if (kinds[match.index] !== KIND_CODE) return
    const open = enclosingOpeningTagStart(source, match.index, kinds)
    if (open < 0) return
    const end = openingTagEnd(source, open, kinds)
    const tag = source.slice(open, end + 1)
    if (!/^<(?:button|summary|a)\b/.test(tag) && !/\btabIndex=\{?\s*["']?0["']?\s*\}?/.test(tag)) return
    visit(open, `${match[0]} has no focus-visible ring`)
  })
}

function scanSourceFile(file, push) {
  const { source, kinds } = file
  // Comments are prose about the code, and a regex literal's body is a pattern
  // that happens to be spelled in the same alphabet as a class list or a tag.
  // Neither is markup the product renders, so neither is a place a rule can
  // find a violation.
  const inCode = (index) => kinds[index] !== KIND_COMMENT && kinds[index] !== KIND_REGEX

  forEachMatch(FOCUS_OUTLINE_NONE, source, (match) => {
    if (!inCode(match.index)) return
    if (FOCUS_RING_PRESENT.test(classContext(file, match.index, 1500))) return
    push('focus-ring-removed', file, match.index, 'focus:outline-none')
  })

  forEachMatch(FOCUS_BORDER_SWAP, source, (match) => {
    if (!inCode(match.index)) return
    push('focus-border-swap', file, match.index, match[0])
  })

  forEachMatch(SPACING_ARBITRARY, source, (match) => {
    if (!inCode(match.index)) return
    const value = Number(match[1])
    if (Number.isInteger(value) && value % 2 === 0) return
    push('spacing-off-grid', file, match.index, match[0])
  })

  forEachMatch(EMOJI, source, (match) => {
    if (!inCode(match.index)) return
    if (EMOJI_ALLOWED.has(match[0])) return
    push('emoji-as-icon', file, match.index, match[0])
  })

  forEachMatch(ACCENT_LEFT_BORDER, source, (match) => {
    if (!inCode(match.index)) return
    push('selection-accent-bar', file, match.index, match[0])
  })

  forEachMatch(ACCENT_BORDER, source, (match) => {
    if (!inCode(match.index)) return
    if (!LEFT_BORDER_WIDTH.test(classContext(file, match.index, 900))) return
    push('selection-accent-bar', file, match.index, match[0])
  })

  forEachMatch(BACKDROP_FILTER, source, (match) => {
    if (!inCode(match.index)) return
    push('backdrop-filter', file, match.index, match[0])
  })

  if (!GLASS_CONSUMER_FILES.has(file.path)) {
    forEachMatch(GLASS_UTILITY_PATTERN, source, (match) => {
      if (!inCode(match.index)) return
      push('backdrop-filter', file, match.index, `${match[0]} (glass belongs to the kit's sanctioned shells)`)
    })
  }

  if (!SCRIM_GLASS_CONSUMER_FILES.has(file.path)) {
    forEachMatch(SCRIM_GLASS_UTILITY_PATTERN, source, (match) => {
      if (!inCode(match.index)) return
      push('backdrop-filter', file, match.index, `${match[0]} (the one blurred scrim is the command palette's)`)
    })
  }

  forEachMatch(TAILWIND_SHADOW, source, (match) => {
    if (!inCode(match.index)) return
    push('shadow-in-flow', file, match.index, match[0])
  })

  forEachMatch(ARBITRARY_Z, source, (match) => {
    if (!inCode(match.index)) return
    const named = match[1].trim().match(LADDER_Z_VAR)
    if (named) {
      if (Z_LADDER_NAMES.has(named[1])) return
      push('named-z-off-ladder', file, match.index, match[0])
      return
    }
    push('arbitrary-z-index', file, match.index, match[0])
  })

  forEachMatch(ACCENT_FILL, source, (match) => {
    if (!inCode(match.index)) return
    const context = classContext(file, match.index, 700)
    if (!ACTIVE_CONDITION.test(context)) return
    // A hairline underline or rule may carry the accent — the budget permits
    // accent as ink or a hairline, only not as a fill.
    if (HAIRLINE_SHAPE.test(context)) return
    // A left bar belongs to selection-accent-bar; the two rules stay disjoint so
    // one violation is reported once, under the rule whose fix hint applies.
    if (ACCENT_LEFT_BORDER.test(context) || ACCENT_BORDER.test(context)) {
      ACCENT_LEFT_BORDER.lastIndex = 0
      ACCENT_BORDER.lastIndex = 0
      return
    }
    push('accent-marks-active', file, match.index, match[0])
  })

  forEachMatch(UPPERCASE, source, (match) => {
    if (!inCode(match.index)) return
    const context = classContext(file, match.index, 400)
    if (!TRACKING.test(context)) return
    if (/<kbd/i.test(context)) return
    push('uppercase-tracked', file, match.index, 'uppercase + tracking-*')
  })

  forEachMatch(GROUP_HOVER_REVEAL, source, (match) => {
    if (!inCode(match.index)) return
    if (FOCUS_REVEAL.test(classContext(file, match.index, 1500))) return
    push('hover-without-focus', file, match.index, match[0])
  })

  forEachMatch(MARKETING_RADIUS, source, (match) => {
    if (!inCode(match.index)) return
    if (match[1] !== undefined && Number(match[1]) < MARKETING_RADIUS_FLOOR_PX) return
    push('marketing-radii', file, match.index, match[0])
  })

  forEachMatch(TEXT_SIZE, source, (match) => {
    if (!inCode(match.index)) return
    if (Number(match[1]) >= MICRO_FLOOR_PX) return
    push('micro-type-floor', file, match.index, match[0])
  })

  forEachMatch(FLEXLAYOUT_SCOPED_VAR, source, (match) => {
    if (!inCode(match.index)) return
    push('flexlayout-scoped-var', file, match.index, match[0])
  })

  forEachMatch(WEIGHT_OFF_RAMP, source, (match) => {
    if (!inCode(match.index)) return
    push('weight-off-ramp', file, match.index, match[0])
  })

  forEachMatch(NAMED_Z, source, (match) => {
    if (!inCode(match.index)) return
    if (NAMED_Z_ALLOWED.has(Number(match[1]))) return
    push('named-z-off-ladder', file, match.index, match[0])
  })

  forEachMatch(SPACING_NAMED, source, (match) => {
    if (!inCode(match.index)) return
    if (SPACING_STEPS_ON_SCALE.has(Number(match[1]))) return
    push('spacing-off-scale', file, match.index, match[0])
  })

  forEachMatch(RADIUS_ARBITRARY, source, (match) => {
    if (!inCode(match.index)) return
    const px = Number(match[1])
    if (RADIUS_STEPS_PX.has(px)) return
    // At or above the marketing floor the marketing-radii rule already reports it.
    if (px >= MARKETING_RADIUS_FLOOR_PX) return
    push('radius-off-ramp', file, match.index, match[0])
  })

  forEachMatch(RADIUS_XL, source, (match) => {
    if (!inCode(match.index)) return
    push('radius-off-ramp', file, match.index, match[0])
  })

  forEachMatch(DISABLED_INK, source, (match) => {
    if (!inCode(match.index)) return
    const tag = enclosingOpeningTag(source, match.index, kinds)
    if (!tag || !TEXT_ELEMENT_TAG.test(tag)) return
    if (ELEMENT_DISABLED.test(tag)) return
    push('disabled-ink-copy', file, match.index, match[0])
  })

  scanFocusRingMissing(file, push)
}

function forEachMatch(regex, source, visit) {
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(source))) {
    visit(match)
    if (match[0].length === 0) regex.lastIndex += 1
  }
}

/* ------------------------------------------------------------------ *
 * CSS parsing
 * ------------------------------------------------------------------ */

function maskCssComments(source) {
  const kinds = new Uint8Array(source.length)
  let i = 0
  while (i < source.length - 1) {
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      kinds.fill(KIND_COMMENT, i, stop)
      i = stop
      continue
    }
    i += 1
  }
  return kinds
}

// Every top-level `selector { … }` rule, in document order. Comments are
// stripped from the selector so a block preceded by a doc comment still reads
// correctly — every token block in both stylesheets is.
function readTopLevelBlocks(source, kinds) {
  const blocks = []
  let selectorStart = 0
  let i = 0
  while (i < source.length) {
    if (kinds[i] === KIND_COMMENT) {
      // A comment never belongs to the selector that follows it.
      while (i < source.length && kinds[i] === KIND_COMMENT) i += 1
      selectorStart = i
      continue
    }
    const ch = source[i]
    if (ch === ';') {
      selectorStart = i + 1
      i += 1
      continue
    }
    if (ch !== '{') {
      i += 1
      continue
    }
    const selector = source.slice(selectorStart, i).trim()
    let depth = 1
    let end = i + 1
    while (end < source.length && depth > 0) {
      if (kinds[end] !== KIND_COMMENT) {
        if (source[end] === '{') depth += 1
        else if (source[end] === '}') depth -= 1
      }
      end += 1
    }
    blocks.push({ selector, bodyStart: i + 1, bodyEnd: end - 1 })
    i = end
    selectorStart = end
  }
  return blocks
}

// The subset whose selector list is made only of bare `:root` parts and
// single-attribute `:root[…]` parts. Blocks with a descendant selector (the git
// ref pills, the date-picker chrome) are not token blocks and are skipped.
//
// `data-theme` parts name the themes a block declares for. Any other attribute
// (`data-window-material`) is a conditional overlay: it declares for no theme in
// particular and stacks on top of whichever one is active, so it contributes
// nothing to the cascade the ramp check walks — but it is still a `:root` block
// that can carry a token, which is why it is read rather than skipped.
function readRootBlocks(source, kinds) {
  const blocks = []
  for (const block of readTopLevelBlocks(source, kinds)) {
    const parts = block.selector.split(',').map((part) => part.trim())
    if (!parts.every((part) => /^:root(?:\[[\w-]+="[\w-]+"\])?$/.test(part))) continue
    blocks.push({
      ...block,
      parts,
      themes: parts
        .map((part) => part.match(/\[data-theme="([\w-]+)"\]/)?.[1] ?? null)
        .filter((theme) => theme !== null),
      appliesToAllThemes: parts.some((part) => part === ':root'),
    })
  }
  return blocks
}

// `bundleMode` records which mode of the bundle a `var(--sem-…)` alias in this
// block resolves against, so the ramp check keeps working after the app stops
// restating literals. Only the base dark block and the light block carry
// aliases (they are the two modes the bundle ships); the other themes hold
// their own literals and specificity keeps them winning.
function readDeclarations(source, kinds, block, bundleMode = null) {
  const declarations = new Map()
  const pattern = /(--[\w-]+)\s*:\s*([^;}]*)(;|})/g
  pattern.lastIndex = block.bodyStart
  let match
  while ((match = pattern.exec(source))) {
    if (match.index >= block.bodyEnd) break
    if (kinds[match.index] === KIND_COMMENT) continue
    declarations.set(match[1], { value: match[2].trim(), index: match.index, bundleMode })
  }
  return declarations
}

// Follow `var(…)` to a literal: into the bundle for a `--sem-*` alias, or
// through the theme's own map for an app-level indirection. `color-mix()` and
// anything else that needs a real CSS engine stays unresolved.
function resolveTokenValue(name, resolved, bundle, depth = 0) {
  if (depth > 4) return null
  const declaration = resolved.get(name)
  if (!declaration) return null
  const reference = declaration.value.match(/^var\((--[\w-]+)\)$/)
  if (!reference) return declaration.value
  if (reference[1].startsWith('--sem-')) {
    if (!declaration.bundleMode) return null
    return bundle[declaration.bundleMode].get(reference[1]) ?? null
  }
  return resolveTokenValue(reference[1], resolved, bundle, depth + 1)
}

/* ------------------------------------------------------------------ *
 * Colour maths
 * ------------------------------------------------------------------ */

function parseColor(value) {
  const text = value.trim()
  const hex = text.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      return [0, 1, 2].map((i) => parseInt(digits[i] + digits[i], 16))
    }
    if (digits.length === 6 || digits.length === 8) {
      return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))
    }
    return null
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i)
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map((part) => Number(part))
    if (channels.some((channel) => !Number.isFinite(channel))) return null
    // Only opaque colours are compared; an alpha value would need the surface
    // beneath it to mean anything, and the ink ramp is opaque in every theme.
    if (parts.length > 3 && Number(parts[3]) < 1) return null
    return channels
  }
  return null
}

function relativeLuminance([r, g, b]) {
  const channel = (raw) => {
    const value = raw / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(a, b) {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/* ------------------------------------------------------------------ *
 * Token-layer rules
 * ------------------------------------------------------------------ */

// App variable → its counterpart in the design-system bundle. Name-for-name,
// not name-identical: `--text-strong` is the bundle's `text-primary`. Only
// variables with a true counterpart appear here — `--tone-accent-soft`,
// `--focus-ring`, `--agent-surface` and the rest of the app-only layer are
// deliberately absent, and so is anything the bundle does not declare.
const APP_TO_BUNDLE = new Map(
  Object.entries({
    '--bg-app': '--sem-color-bg-app',
    '--bg-surface': '--sem-color-bg-surface',
    '--bg-surface-raised': '--sem-color-bg-surface-raised',
    '--bg-hover': '--sem-color-bg-hover',
    '--bg-active': '--sem-color-bg-active',
    '--bg-selected': '--sem-color-bg-selected',
    '--bg-selected-resting': '--sem-color-bg-selected-resting',
    '--text-strong': '--sem-color-text-primary',
    '--text-default': '--sem-color-text-default',
    '--text-muted': '--sem-color-text-muted',
    '--text-subtle': '--sem-color-text-subtle',
    '--text-disabled': '--sem-color-text-disabled',
    '--text-on-accent': '--sem-color-text-on-accent',
    '--border-subtle': '--sem-color-border-subtle',
    '--border-default': '--sem-color-border-default',
    '--border-strong': '--sem-color-border-strong',
    '--border-focus': '--sem-color-border-focus',
    '--accent-primary': '--sem-color-accent-primary',
    '--accent-primary-hover': '--sem-color-accent-hover',
    '--accent-primary-soft': '--sem-color-accent-soft',
    '--accent-primary-soft-strong': '--sem-color-accent-soft-strong',
    '--surface-overlay-backdrop': '--sem-color-overlay-scrim',
    '--tone-neutral': '--sem-color-status-neutral',
    '--tone-good': '--sem-color-status-good',
    '--tone-warn': '--sem-color-status-warn',
    '--tone-error': '--sem-color-status-danger',
    '--tone-merged': '--sem-color-status-merged',
    '--tone-neutral-soft': '--sem-color-status-neutral-soft',
    '--tone-good-soft': '--sem-color-status-good-soft',
    '--tone-warn-soft': '--sem-color-status-warn-soft',
    '--tone-error-soft': '--sem-color-status-danger-soft',
    '--shadow-drawer': '--sem-shadow-drawer',
    '--shadow-popover': '--sem-shadow-popover',
    '--shadow-modal': '--sem-shadow-modal',
    '--shadow-toast': '--sem-shadow-toast',
    '--shadow-control-raised': '--sem-shadow-control-raised',
    '--shadow-control-thumb': '--sem-shadow-control-thumb',
    '--text-size-2xs': '--sem-font-size-micro',
    '--text-size-xs': '--sem-font-size-meta',
    '--text-size-sm': '--sem-font-size-body',
    '--text-size-md': '--sem-font-size-heading',
    '--text-size-lg': '--sem-font-size-title',
    '--text-line-tight': '--sem-font-line-tight',
    '--text-line-default': '--sem-font-line-default',
    '--text-line-relaxed': '--sem-font-line-relaxed',
    '--icon-xs': '--sem-icon-size-xs',
    '--icon-sm': '--sem-icon-size-sm',
    '--icon-md': '--sem-icon-size-md',
    '--icon-lg': '--sem-icon-size-lg',
    '--radius-xs': '--sem-radius-chip',
    '--radius-sm': '--sem-radius-control',
    '--radius-md': '--sem-radius-overlay',
    '--radius-lg': '--sem-radius-shell',
    '--motion-fast': '--sem-motion-duration-fast',
    '--motion-normal': '--sem-motion-duration-normal',
    '--motion-deliberate': '--sem-motion-duration-deliberate',
    '--motion-pulse': '--sem-motion-duration-pulse',
    '--motion-ease': '--sem-motion-ease-standard',
  }),
)

const RAMP = ['--text-strong', '--text-default', '--text-muted', '--text-subtle', '--text-disabled']
const DISABLED_CONTRAST_FLOOR = 3
// Every surface disabled ink is actually painted on. `--bg-surface-raised` is
// real chrome — the model popover paints it and renders `--text-disabled`
// inside it, as do `CommandPalette`, `ConfirmDialog`, `KbdChord` and
// `SkillPickerPopover`. `--bg-selected` is deliberately absent: no surface in
// the tree pairs it with disabled ink today, and a floor no rendered surface
// needs is a rule that fails on nothing.
const DISABLED_CONTRAST_SURFACES = ['--bg-surface', '--bg-surface-raised', '--bg-app']

// The tolerated `"<theme>:<surface>"` pairings, mapped to the line each is
// written on so a stale entry reports somewhere a reader can open. A missing
// file is zero tolerance, which is what deleting it must mean.
function readDisabledContrastBaseline() {
  const abs = resolve(repoRoot, DISABLED_CONTRAST_BASELINE_PATH)
  if (!existsSync(abs)) return new Map()
  const raw = readFileSync(abs, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write(`${DISABLED_CONTRAST_BASELINE_PATH} is not valid JSON.\n`)
    process.exit(2)
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    process.stderr.write(`${DISABLED_CONTRAST_BASELINE_PATH} must be a JSON array of "<theme>:<surface>" strings.\n`)
    process.exit(2)
  }
  const lines = raw.split('\n')
  const tolerated = new Map()
  for (const entry of parsed) {
    const at = lines.findIndex((line) => line.includes(`"${entry}"`))
    tolerated.set(entry, at === -1 ? 1 : at + 1)
  }
  return tolerated
}

function resolveBundle(bundleSource) {
  const kinds = maskCssComments(bundleSource)
  const light = new Map()
  const dark = new Map()
  for (const block of readTopLevelBlocks(bundleSource, kinds)) {
    const target = block.selector === ':root' ? light : block.selector === '[data-mode="dark"]' ? dark : null
    if (!target) continue
    const body = bundleSource.slice(block.bodyStart, block.bodyEnd)
    const declaration = /(--[\w-]+)\s*:\s*([^;}]*)[;}]/g
    let entry
    while ((entry = declaration.exec(body))) {
      target.set(entry[1], entry[2].trim())
    }
  }
  const darkResolved = new Map(light)
  for (const [name, value] of dark) darkResolved.set(name, value)
  return {
    light: flattenRefs(light),
    dark: flattenRefs(darkResolved),
  }
}

// The bundle's `sem` tier points at the `ref` tier; the app compares against
// final values, so follow one `var(--ref-…)` hop.
function flattenRefs(map) {
  const flat = new Map()
  for (const [name, value] of map) {
    const reference = value.match(/^var\((--[\w-]+)\)$/)
    flat.set(name, reference && map.has(reference[1]) ? map.get(reference[1]) : value)
  }
  return flat
}

function normalizeValue(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/* ------------------------------------------------------------------ *
 * Rule registry
 * ------------------------------------------------------------------ */

const RULE_IDS = [
  'focus-ring-removed',
  'focus-border-swap',
  'spacing-off-grid',
  'emoji-as-icon',
  'selection-accent-bar',
  'backdrop-filter',
  'shadow-in-flow',
  'arbitrary-z-index',
  'accent-marks-active',
  'uppercase-tracked',
  'hover-without-focus',
  'marketing-radii',
  'micro-type-floor',
  'flexlayout-scoped-var',
  'weight-off-ramp',
  'named-z-off-ladder',
  'spacing-off-scale',
  'radius-off-ramp',
  'disabled-ink-copy',
  'focus-ring-missing',
  'app-token-restates-bundle',
  'theme-ramp-contrast',
]

const FIX_HINT = {
  'focus-ring-removed': 'add FOCUS_RING_CLASS from components/ui/tokens.ts to the same element',
  'focus-border-swap':
    'delete the border swap and wear the ring: FOCUS_RING_CLASS, or the wrapper/inset/terminal ' +
    'variant beside it in components/ui/tokens.ts',
  'spacing-off-grid': 'use the nearest sem.space step (2, 4, 6, 8, 10, 12, 16, 20, 24, 32)',
  'emoji-as-icon': 'use a glyph from components/AppIcons.tsx, or delete the decoration',
  'selection-accent-bar': 'selection is a neutral --bg-selected fill with no left bar',
  'backdrop-filter':
    'separation comes from the scrim tone plus the shell shadow; glass is the toast card, ' +
    'Popover / PointerPopover material="glass" and the command palette shell (surface-glass in the kit), ' +
    "the palette's scrim over a conversation (scrim-glass), and nothing else blurs or borrows them",
  'shadow-in-flow':
    'overlays take --shadow-popover / --shadow-modal; the primary action takes .control-raised and a ' +
    'segmented thumb .control-thumb; all other in-flow chrome, controls included, takes a hairline',
  'arbitrary-z-index':
    'use the layering scale: sticky 10, pane 20, float 30, drawer 40, modal 70, popover 80, menu 90, toast 100',
  'accent-marks-active': 'mark active with --bg-selected and an ink lift, not the accent',
  'uppercase-tracked': 'sentence case; hierarchy from weight and size',
  'marketing-radii': 'operational chrome uses --radius-sm / --radius-md',
  'hover-without-focus': 'pair the hover reveal with group-focus-within:opacity-100',
  'micro-type-floor': `grow the container rather than shrinking the type below ${MICRO_FLOOR_PX}px`,
  'flexlayout-scoped-var': '--color-N exists only inside .flexlayout__layout; use --border-default / --border-strong',
  'weight-off-ramp': 'the weight ramp is 400 / 500 / 600: font-semibold is the top step',
  'named-z-off-ladder':
    'z-[var(--z-pane)] (20) / z-[var(--z-float)] (30) in flow; --z-drawer and above for ' +
    'overlays. A name the ladder does not declare resolves to nothing: check the spelling ' +
    'against sem.z.* in design-system/foundations/tokens.tokens.json',
  'spacing-off-scale':
    'move to the neighbouring sem.space step; an indent aligning to a glyph slot keeps its value with a design-tokens-allow: reason',
  'radius-off-ramp': 'rounded-xs / -sm / -md / -lg (3 / 7 / 7 / 9px — control and overlay share 7)',
  'disabled-ink-copy': 'copy is read: --text-muted (or EmptyState / Section); disabled ink is for disabled controls',
  'focus-ring-missing': 'use the kit control, or add FOCUS_RING_CLASS (inset variant on full-bleed rows)',
  'app-token-restates-bundle':
    'alias the bundle variable instead of restating its value, keep mapped names in the ' +
    'base dark and light blocks, and drop every alias to a token the bundle has retired',
  'theme-ramp-contrast': 'order the ink ramp identically in every theme and clear 3:1 on disabled',
}

/* ------------------------------------------------------------------ *
 * Scan
 * ------------------------------------------------------------------ */

function walkSource(absoluteRoot, root) {
  const out = []
  if (!existsSync(absoluteRoot)) return out
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    const full = join(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...walkSource(full, root))
      continue
    }
    if (!entry.isFile()) continue
    if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) continue
    if (entry.name.endsWith('.d.ts')) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0 || !SOURCE_EXT.has(entry.name.slice(dot))) continue
    out.push(
      full
        .slice(root.length + 1)
        .split(sep)
        .join('/'),
    )
  }
  return out
}

const args = process.argv.slice(2)
const REPORT_ONLY = args.includes('--report')
const QUIET = args.includes('--quiet')

// The baseline mechanism is gone (see "## Tolerance"). Fail loudly rather than
// silently running at zero tolerance for someone reaching for the old flag.
if (args.includes('--write-baseline')) {
  process.stderr.write(
    'This guard no longer carries baselines: every rule sweeps clean and any violation fails.\n' +
      'Fix the violation, or document a genuine exception with a `design-tokens-allow: <reason>` marker.\n',
  )
  process.exit(2)
}

const violations = []
const markerErrors = []

function push(rule, file, index, text) {
  const line = lineOf(file.starts, index)
  const lineStart = file.starts[line - 1]
  violations.push({ rule, path: file.path, line, column: index - lineStart + 1, text })
}

function pushAt(rule, path, line, text) {
  violations.push({ rule, path, line, column: 1, text })
}

function collectMarkerLines(path, lines) {
  const marked = new Set()
  lines.forEach((line, index) => {
    const at = line.indexOf(ALLOW_MARKER)
    if (at === -1) return
    // Strip whatever closes the comment — `*/`, `*/}` in a JSX comment, `-->`
    // — then require the reason to carry actual words, not punctuation.
    const reason = line.slice(at + ALLOW_MARKER.length).replace(/[*/}>\-\s]+$/, '')
    if (!/[A-Za-z0-9]/.test(reason)) {
      markerErrors.push({ path, line: index + 1 })
      return
    }
    marked.add(index + 1)
    marked.add(index + 2)
    marked.add(index + 3)
  })
  return marked
}

const sourceFiles = walkSource(resolve(repoRoot, SOURCE_ROOT), repoRoot).sort()
const markerLinesByPath = new Map()

for (const path of sourceFiles) {
  const source = readFileSync(resolve(repoRoot, path), 'utf8')
  const lines = source.split('\n')
  const file = {
    path,
    source,
    lines,
    starts: lineStarts(source),
    kinds: classifySource(source),
  }
  markerLinesByPath.set(path, collectMarkerLines(path, lines))
  scanSourceFile(file, push)
}

// --- Token layer -----------------------------------------------------

const appCssAbs = resolve(repoRoot, APP_CSS_PATH)
const bundleCssAbs = resolve(repoRoot, BUNDLE_CSS_PATH)

if (!existsSync(appCssAbs) || !existsSync(bundleCssAbs)) {
  process.stderr.write(`Missing ${existsSync(appCssAbs) ? BUNDLE_CSS_PATH : APP_CSS_PATH}. Run from the repo root.\n`)
  process.exit(2)
}

const appCss = readFileSync(appCssAbs, 'utf8')
const appCssKinds = maskCssComments(appCss)
const appCssStarts = lineStarts(appCss)
const appCssLines = appCss.split('\n')
markerLinesByPath.set(APP_CSS_PATH, collectMarkerLines(APP_CSS_PATH, appCssLines))

// The app CSS may blur in exactly two places: the `surface-glass` utility and
// the palette scrim's `scrim-glass`.
{
  // Comment text (the prose that explains the ban) is skipped by kind.
  const masked = appCss
  const blockOf = (utility) => {
    const utilityAt = masked.indexOf(`@utility ${utility} {`)
    if (utilityAt === -1) return null
    let depth = 0
    for (let i = masked.indexOf('{', utilityAt); i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1
      if (masked[i] === '}') {
        depth -= 1
        if (depth === 0) return { start: utilityAt, end: i }
      }
    }
    return null
  }
  const blocks = [blockOf(GLASS_UTILITY), blockOf(SCRIM_GLASS_UTILITY)].filter(Boolean)
  const cssBackdrop = /backdrop-filter\s*:/g
  forEachMatch(cssBackdrop, masked, (match) => {
    if (appCssKinds[match.index] === KIND_COMMENT) return
    const inside = blocks.some((block) => match.index > block.start && match.index < block.end)
    if (inside) return
    pushAt('backdrop-filter', APP_CSS_PATH, lineOf(appCssStarts, match.index), match[0])
  })
}

const bundle = resolveBundle(readFileSync(bundleCssAbs, 'utf8'))

// A `--sem-*` the bundle does not declare. Retiring a token removes it from
// `tokens.css`, and every `var(--sem-…)` in `index.css` that still names it
// stops resolving: the declaration is invalid at computed-value time and the
// property falls back to its initial value, so a retired shadow paints as
// `none` and a retired colour as the inherited one. Both look deliberate in
// review and in the running app. The bundle's light block declares every
// token, so it is the whole vocabulary.
forEachMatch(/var\(\s*(--sem-[\w-]+)/g, appCss, (match) => {
  if (appCssKinds[match.index] === KIND_COMMENT) return
  if (bundle.light.has(match[1])) return
  pushAt(
    'app-token-restates-bundle',
    APP_CSS_PATH,
    lineOf(appCssStarts, match.index),
    `${match[1]} is not declared in design-system/foundations/tokens.css, so this resolves to nothing`,
  )
})
const rootBlocks = readRootBlocks(appCss, appCssKinds)

const baseBlock = rootBlocks.find((block) => block.appliesToAllThemes && block.themes.includes('dark'))
const lightBlock = rootBlocks.find(
  (block) => !block.appliesToAllThemes && block.themes.length === 1 && block.themes[0] === 'light',
)

if (!baseBlock || !lightBlock) {
  process.stderr.write(`Could not locate the base dark and light token blocks in ${APP_CSS_PATH}.\n`)
  process.exit(2)
}

// The two blocks that carry the mapping. They are the only place a mapped name
// may alias the bundle: the base block IS the dark mode and the light block IS
// the light mode, so a `var(--sem-…)` written there resolves against a known
// polarity. Everywhere else the mode is whatever is active, which is not a
// thing the alias can be checked against.
const ALIAS_BLOCKS = new Map([
  [baseBlock, { bundleValues: bundle.dark, modeLabel: 'dark' }],
  [lightBlock, { bundleValues: bundle.light, modeLabel: 'light' }],
])

const SEM_ALIAS = /^var\((--sem-[\w-]+)\)$/

// Every `:root`-family block, not just the two that alias. A mapped name
// declared in a bare `:root` block outside the mapping wins the cascade for
// every theme that does not declare that name itself — 18 of 19 today, since
// only `dark` is picked up by the base block's higher-specificity half. Its
// value is beside the point: the block is the violation.
for (const block of rootBlocks) {
  const aliasBlock = ALIAS_BLOCKS.get(block)
  const declarations = readDeclarations(appCss, appCssKinds, block)
  for (const [name, declaration] of declarations) {
    const counterpart = APP_TO_BUNDLE.get(name)
    if (!counterpart) continue
    const line = lineOf(appCssStarts, declaration.index)
    const alias = declaration.value.match(SEM_ALIAS)

    if (!aliasBlock) {
      // A theme block holds its own literal palette — that is the design, and
      // specificity keeps it winning. What it must not do is alias, or be a
      // second all-themes block shadowing the mapping.
      if (block.appliesToAllThemes || block.themes.length === 0) {
        pushAt(
          'app-token-restates-bundle',
          APP_CSS_PATH,
          line,
          `${name} is mapped to ${counterpart} but declared in \`${block.selector}\`, which ` +
            'applies to every theme; only the base dark and light blocks may carry a mapped name',
        )
      } else if (alias) {
        pushAt(
          'app-token-restates-bundle',
          APP_CSS_PATH,
          line,
          `theme "${block.themes.join('/')}" ${name} aliases ${alias[1]}, but a theme block ` +
            'resolves against whichever mode is active; only the base dark and light blocks may alias',
        )
      }
      continue
    }

    // The mapping rule polices the mapping. An alias to some other `--sem-*` is
    // the one error a hand-written name-for-name map is most likely to carry,
    // and it is invisible both in a diff and in the value the guard reads back.
    if (alias) {
      if (alias[1] === counterpart) continue
      pushAt(
        'app-token-restates-bundle',
        APP_CSS_PATH,
        line,
        `${aliasBlock.modeLabel} ${name} aliases ${alias[1]}, counterpart is ${counterpart}`,
      )
      continue
    }

    const bundleValue = aliasBlock.bundleValues.get(counterpart)
    if (bundleValue === undefined) continue
    const matches = normalizeValue(bundleValue) === normalizeValue(declaration.value)
    pushAt(
      'app-token-restates-bundle',
      APP_CSS_PATH,
      line,
      `${aliasBlock.modeLabel} ${name} ${matches ? 'restates' : 'drifts from'} ${counterpart} ` +
        `(app ${declaration.value}${matches ? '' : `, bundle ${bundleValue}`})`,
    )
  }
}

// Ramp + contrast, per theme. A theme resolves against every preceding block
// that applies to it, exactly as the cascade does.
const themeIds = new Set()
for (const block of rootBlocks) for (const theme of block.themes) themeIds.add(theme)

const disabledContrastBaseline = readDisabledContrastBaseline()
const toleratedDisabledContrast = []

for (const theme of [...themeIds].sort()) {
  const resolved = new Map()
  for (const block of rootBlocks) {
    if (!block.appliesToAllThemes && !block.themes.includes(theme)) continue
    // The base block applies to every theme, but its `var(--sem-…)` aliases
    // only resolve for the mode that block IS. A light-family theme falling
    // through to a base alias would read the wrong mode's value, so its mode
    // is left unknown rather than guessed — see the unresolved branch below.
    const bundleMode =
      block === baseBlock && theme === 'dark' ? 'dark' : block === lightBlock && theme === 'light' ? 'light' : null
    for (const [name, declaration] of readDeclarations(appCss, appCssKinds, block, bundleMode)) {
      resolved.set(name, declaration)
    }
  }
  const surfaces = DISABLED_CONTRAST_SURFACES.map((name) => {
    const declaration = resolved.get(name)
    const value = declaration ? resolveTokenValue(name, resolved, bundle) : null
    return { name, declaration, value, color: value ? parseColor(value) : null }
  })
  // The ramp's polarity is judged against `--bg-surface`, the surface it is
  // authored against; the other two are measured, never used to decide a mode.
  const surfaceColor = surfaces.find((entry) => entry.name === '--bg-surface').color
  const ramp = RAMP.map((name) => {
    const declaration = resolved.get(name)
    const value = declaration ? resolveTokenValue(name, resolved, bundle) : null
    return {
      name,
      declaration,
      value,
      color: value ? parseColor(value) : null,
    }
  })
  // A value the guard cannot resolve to an opaque colour — a `color-mix()`, a
  // translucent ink, a bundle alias whose mode is ambiguous — is reported, not
  // skipped. Silently passing a theme the guard could not actually check is the
  // failure mode this rule exists to prevent; the carve-out marker is the way
  // out when a value is genuinely beyond it.
  const unresolved = [
    ...surfaces.filter((entry) => entry.color === null),
    ...ramp.filter((step) => step.color === null),
  ]
  if (unresolved.length > 0) {
    for (const step of unresolved) {
      pushAt(
        'theme-ramp-contrast',
        APP_CSS_PATH,
        step.declaration ? lineOf(appCssStarts, step.declaration.index) : 1,
        `theme "${theme}": ${step.name} (${step.declaration?.value ?? 'undeclared'}) does not ` +
          'resolve to an opaque colour, so the ramp cannot be checked',
      )
    }
    continue
  }

  const luminance = ramp.map((step) => relativeLuminance(step.color))
  const darkMode = luminance[0] > relativeLuminance(surfaceColor)
  for (let i = 1; i < ramp.length; i += 1) {
    const ordered = darkMode ? luminance[i] < luminance[i - 1] : luminance[i] > luminance[i - 1]
    if (ordered) continue
    const declaration = ramp[i].declaration
    pushAt(
      'theme-ramp-contrast',
      APP_CSS_PATH,
      lineOf(appCssStarts, declaration.index),
      `theme "${theme}": ${ramp[i].name} (${ramp[i].value}) inverts against ` +
        `${ramp[i - 1].name} (${ramp[i - 1].value})`,
    )
  }

  const disabled = ramp[ramp.length - 1]
  for (const surface of surfaces) {
    const ratio = contrastRatio(disabled.color, surface.color)
    if (ratio >= DISABLED_CONTRAST_FLOOR) continue
    const pairing = `${theme}:${surface.name}`
    if (disabledContrastBaseline.has(pairing)) {
      toleratedDisabledContrast.push({ pairing, ratio })
      disabledContrastBaseline.delete(pairing)
      continue
    }
    pushAt(
      'theme-ramp-contrast',
      APP_CSS_PATH,
      lineOf(appCssStarts, disabled.declaration.index),
      `theme "${theme}": --text-disabled (${disabled.value}) is ` +
        `${ratio.toFixed(2)}:1 on ${surface.name} (${surface.value}), under the ${DISABLED_CONTRAST_FLOOR}:1 floor`,
    )
  }
}

// Whatever the baseline still holds names a pairing that no longer fails — or
// never did. Either way the entry is now the only thing standing between this
// check and zero tolerance, so it fails until it is deleted.
for (const [pairing, line] of disabledContrastBaseline) {
  pushAt(
    'theme-ramp-contrast',
    DISABLED_CONTRAST_BASELINE_PATH,
    line,
    `"${pairing}" clears the ${DISABLED_CONTRAST_FLOOR}:1 disabled floor (or names no measured ` +
      'pairing); delete the entry',
  )
}

/* ------------------------------------------------------------------ *
 * Exemptions and report
 * ------------------------------------------------------------------ */

const suppressed = violations.filter((violation) => markerLinesByPath.get(violation.path)?.has(violation.line))
const suppressedSet = new Set(suppressed)
// Everything an allow-marker did not carve out is a failure. There is nothing
// between "the marker documents why" and "fix it".
const live = violations.filter((violation) => !suppressedSet.has(violation))

const byRule = new Map(RULE_IDS.map((rule) => [rule, []]))
for (const violation of live) byRule.get(violation.rule).push(violation)
for (const list of byRule.values()) list.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)

if (!QUIET) {
  const grouped = new Map()
  for (const violation of live) {
    if (!grouped.has(violation.path)) grouped.set(violation.path, [])
    grouped.get(violation.path).push(violation)
  }
  for (const [path, list] of [...grouped.entries()].sort()) {
    process.stdout.write(`\n${path}\n`)
    for (const violation of list.sort((a, b) => a.line - b.line || a.column - b.column)) {
      process.stdout.write(`  ${violation.line}:${violation.column}  ${violation.rule}  ${violation.text}\n`)
    }
  }
  for (const error of markerErrors) {
    process.stdout.write(
      `\n${error.path}\n  ${error.line}:1  allow-marker-without-reason  ` +
        `\`${ALLOW_MARKER} <reason>\` needs a reason\n`,
    )
  }
}

if (!QUIET) {
  process.stdout.write('\nDesign-system conformance summary\n')
  process.stdout.write(
    `  scope: ${SOURCE_ROOT} (${sourceFiles.length} files) + ${APP_CSS_PATH} vs ${BUNDLE_CSS_PATH}\n`,
  )
  process.stdout.write(
    toleratedDisabledContrast.length > 0
      ? '  tolerance: the disabled-contrast baseline below, and nothing else\n'
      : '  tolerance: none — any violation fails\n',
  )
  for (const rule of RULE_IDS) {
    process.stdout.write(`  ${rule}: ${byRule.get(rule).length} found\n`)
  }
  if (suppressed.length > 0) {
    process.stdout.write(`  suppressed by \`${ALLOW_MARKER}\` markers: ${suppressed.length}\n`)
  }
  // Named, with their measured ratios, on every run: a tolerated failure that
  // prints nothing is one nobody clears.
  if (toleratedDisabledContrast.length > 0) {
    process.stdout.write(`  tolerated by ${DISABLED_CONTRAST_BASELINE_PATH}: ${toleratedDisabledContrast.length}\n`)
    for (const { pairing, ratio } of toleratedDisabledContrast) {
      const [theme, surface] = pairing.split(':')
      process.stdout.write(`    ${theme}: --text-disabled ${ratio.toFixed(2)}:1 on ${surface}\n`)
    }
  }
}

const failures = live.length + markerErrors.length
process.stdout.write(`Violations: ${live.length}\n`)

if (failures > 0 && !QUIET) {
  process.stdout.write('\n')
  const rules = new Set(live.map((violation) => violation.rule))
  for (const rule of RULE_IDS) {
    if (rules.has(rule)) process.stdout.write(`  ${rule} — ${FIX_HINT[rule]}\n`)
  }
  process.stdout.write(
    `  Document a genuine exception with \`${ALLOW_MARKER} <reason>\` on the violating\n` +
      '  line or one of the two lines above it.\n',
  )
}

// CI safety: a wrong cwd or a moved tree would otherwise pass silently.
if (sourceFiles.length === 0) {
  process.stdout.write(`\nNo source files under ${SOURCE_ROOT}. Run this from the repo root.\n`)
  process.exit(2)
}

process.exit(!REPORT_ONLY && failures > 0 ? 1 : 0)
