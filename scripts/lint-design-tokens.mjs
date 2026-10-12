#!/usr/bin/env node
// Design-token forbidden-pattern guard for the shared UI redesign.
//
// Scope (intentional): every .tsx and .ts file under
// `src/renderer/src/components/` is scanned. The `__preview__` directory is
// review-only and excluded. The script enforces the rules below across the
// whole component tree so chrome stops accumulating raw colors and gradients
// as new panels and primitives land.
//
// Forbidden patterns inside the scanned files:
//   1. Inline hex color literals (`#abcdef`, `#abc`) in className strings and
//      style attributes. The token layer in src/renderer/src/assets/index.css
//      is the only place those should live.
//   2. Decorative uppercase-tracking chrome like `uppercase tracking-[0.08em]`
//      or `uppercase tracking-wider` used for normal labels.
//   3. CSS `radial-gradient(...)` usage anywhere in the scanned files. The
//      Shared redesign deletes radial decoration on hero, timeline, and
//      graph surfaces; use solid token-backed backgrounds instead.
//   4. Tailwind `bg-gradient-to-*` utilities. Hierarchy comes from typography,
//      spacing, and hairlines, not gradient chrome.
//   5. Hand-rolled inline status dots (`h-2 w-2 rounded-full`) that bypass
//      the canonical `src/renderer/src/components/ui/StatusDot.tsx` primitive.
//   6. `shadow-[0_*]` glow shadows with non-zero blur on operational chrome.
//   7. `no-statusdot-from-app-icons` — importing `StatusDot` from an
//      `AppIcons` module. The canonical primitive is `ui/StatusDot`; the
//      AppIcons re-export was deleted in T9 and must never come back.
//   8. New native renderer dialogs (`confirm`, `prompt`, `alert`, or their
//      `window.*` forms). Existing call sites are temporarily baselined for
//      migration tasks; any count increase fails this guard.
//   9. `no-native-tooltip-on-control` — native `title=` attribute on an
//      interactive control (`<button>`, `<a>`, `<IconButton>`,
//      `<PrimaryButton>`, `<GhostButton>`). The canonical hover/focus tooltip
//      is the `src/renderer/src/components/ui/Tooltip.tsx` primitive; native
//      `title` is slow, ungoverned, and inaccessible on interactive controls.
//      Native `title` remains acceptable on non-interactive elements
//      (truncated identifiers, decorative spans, `<iframe>` for a11y,
//      `<title>` inside SVG).
//
// Two exception mechanisms exist; both must explain the carve-out:
//   * Per-line: a `// design-tokens-allow: <reason>` marker on the same line
//     or one of the two preceding lines.
//   * Per-file: an entry in `PATH_EXEMPTIONS` below that lists which rules
//     are exempt for the path AND, for each, the measured `max` number of
//     occurrences it pays for. The count is the whole point: a blanket
//     per-file exemption hides not just the literals it was written for but
//     every literal added to that file afterwards, so it is an unmonitored
//     region rather than an exception. Occurrence `max`+1 is an ordinary
//     violation; a `max` left ABOVE what the file spends is a violation too,
//     naming the number to write; and an entry whose file no longer exists
//     stops the guard (exit 2). Each entry MUST carry an inline comment that
//     names the exception category (terminal ANSI / memory graph atmosphere
//     / brand SVG) and what the file does. If this list grows beyond
//     `ALLOW_LIST_CEILING` entries, the script emits
//     a meta-finding rather than expanding silently — the redesign drains
//     hex from chrome, it does not catalogue it.
//
// Usage:
//   node scripts/lint-design-tokens.mjs            # fails (exit 1) if any violation
//   node scripts/lint-design-tokens.mjs --report   # never fails; report only
//
// The script prints `file:line:col  rule  matched text` for each finding plus
// a per-file summary, so a review or a work log can quote precise counts
// without re-running the script.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const SCAN_ROOT = 'src/renderer/src/components'
const ALLOWED_EXT = new Set(['.tsx', '.ts'])
// Directories never linted; review-only surfaces.
const EXCLUDED_DIRS = new Set(['__preview__'])

// Per-file rule exemptions. Each entry MUST cite the exception category
// (a) terminal ANSI output, (b) memory graph atmosphere, or (c) brand SVG
// asset — and explain why the rule cannot apply.
//
// Each entry is COUNTED, not blanket. `max` says how many occurrences of each
// listed rule the file is allowed; occurrence N+1 is a violation like any other,
// and a file UNDER its number is a violation too, naming the number to write.
//
// It used to be blanket — name the file, name the rule, and every present and
// FUTURE occurrence in it was invisible. Measuring it found the two failure
// modes that shape predicts: five of the eight entries were at zero (the debt
// they described had been drained, and the exemption was left behind as an open
// door), and one named a file that no longer exists. A blanket per-file
// exemption is not an exception, it is an unmonitored region.
const PATH_EXEMPTIONS = [
  {
    // (b) Memory graph atmosphere: graph node-type palette plus direct canvas
    // paint colors. Pinned to this one canvas file: the graph is an atmospheric
    // surface, not chrome.
    path: 'src/renderer/src/components/memory/MemoryGraphCanvas.tsx',
    rules: ['no-inline-hex'],
    max: { 'no-inline-hex': 19 },
  },
  {
    // (c) Brand SVG asset: per-CLI badge identity colour.
    path: 'src/renderer/src/components/CliIcon.tsx',
    rules: ['no-inline-hex'],
    max: { 'no-inline-hex': 1 },
  },
  {
    // (c) Brand SVG asset: the external editors' marks, in the colours
    // their vendors publish, for the open-in-editor control.
    path: 'src/renderer/src/components/brand/EditorMarks.tsx',
    rules: ['no-inline-hex'],
    max: { 'no-inline-hex': 33 },
  },
]

// Five entries were retired when the list was measured, 2026-09-08. Three
// (`panels/PlainTerminalPanel.tsx`, `panels/TerminalView.tsx`,
// `memory/memoryGraphTypes.ts`) had drained to zero hex literals and were
// standing open over nothing; two (`brand/SprintEngineMark.tsx`,
// `brand/SprintEngineWordmark.tsx`) named files that no longer exist. None of that
// was visible while the exemption was blanket, which is the argument for the
// counts above and for the two checks below.

// Guardrail on the guardrail: when the file-level allow-list exceeds this
// ceiling we emit a meta-finding so a reviewer sees the catalogue growing
// instead of silently shipping more exceptions.
const ALLOW_LIST_CEILING = 10

const ALLOW_MARKER = 'design-tokens-allow:'

// Match `#abc` or `#abcdef` only when used as a color literal. We require the
// `#` to be preceded by a non-word character so we do not match anchor IDs in
// URLs or markdown headings. Pure SVG `fill="#xxxxxx"` attributes are also
// flagged on purpose — icons in the component tree should use `currentColor`.
const HEX_LITERAL = /(?<![\w#])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g

// Match `uppercase` followed (within ~30 chars on the same line) by a
// tracking utility — either `tracking-[…]` or `tracking-wider`/`tracking-widest`.
const UPPERCASE_TRACKING = /uppercase[^\n"`]{0,30}?tracking-(?:\[[^\]]+\]|wider|widest|wide)/g

// Match any `radial-gradient(...)` invocation — Tailwind arbitrary value,
// inline `style` string, or CSS-in-JS literal. The redesign removes radial
// decoration entirely.
const RADIAL_GRADIENT = /radial-gradient\s*\(/g

// Match `bg-gradient-to-` Tailwind utilities (`bg-gradient-to-r`,
// `bg-gradient-to-br`, etc.). The redesign uses solid backgrounds only.
const BG_GRADIENT_TO = /\bbg-gradient-to-[a-z]{1,3}\b/g

// Hand-rolled status-dot regression: any `h-2 w-2 rounded-full` or smaller
// inline dot pattern is a signal someone re-implemented StatusDot. The
// canonical primitive is `src/renderer/src/components/ui/StatusDot.tsx`.
const INLINE_STATUS_DOT = /\bh-(?:1\.5|2)\s+w-(?:1\.5|2)\s+(?:shrink-0\s+)?rounded-full\b/g

// `shadow-[0_*]` with a non-zero blur radius applied to a primary CTA is the
// "glow CTA" anti-pattern the redesign banned. Popover elevation reusing the
// OverflowMenu shadow is allowed via `design-tokens-allow:` markers.
// We match any non-zero-blur shadow string here; per-element classification
// (button vs popover) is delegated to manual review via the allow marker.
const GLOW_SHADOW = /shadow-\[0_[0-9]+(?:px)?_[0-9]+(?:px)?_/g

// no-statusdot-from-app-icons: catches every shape of `StatusDot` import that
// resolves back to the deleted `AppIcons` re-export, both named and aliased.
// The canonical primitive lives at `src/renderer/src/components/ui/StatusDot`.
const STATUSDOT_FROM_APP_ICONS =
  /import\s*(?:type\s+)?(?:\{[^}]*\bStatusDot\b[^}]*\}|StatusDot)\s*from\s*['"][^'"]*AppIcons[^'"]*['"]/g

const NATIVE_DIALOG = /(?<![\w$.])(?:window\s*\.\s*)?(?:confirm|prompt|alert)\s*\(/g

// no-native-tooltip-on-control: matches an opening JSX tag for an interactive
// control (`<button>`, `<a>`, `<IconButton>`, `<PrimaryButton>`,
// `<GhostButton>`) that carries a native `title=` attribute inside the
// opening tag. This regex finds only the tag's OPENING; the walk below finds
// where it closes, because a class list carrying a `>` (`[&>svg]`, a `>` in a
// template) ends a `[^>]*?` regex early and so missed every multi-line control
// that had one (audit 2026-09-02). The reporter shows the tag name plus the
// offending `title=`. SVG `<title>` elements and component props on
// non-interactive primitives (Section, Modal, PanelHeader, etc.) are not
// matched because their tag name does not appear in the alternation.
const INTERACTIVE_TAG_OPEN =
  /<(button|a|IconButton|PrimaryButton|SendButton|GhostButton|OutlineButton|DangerButton|CloseIconButton)\b/g

// Offset kinds for the tag walk. The walker used to track only quotes and
// brace depth, which made it comment-blind three ways (audit 2026-09-02): an
// apostrophe in a `//` comment opened a quote that never closed and the tag was
// silently skipped; a `>` in a `//` comment ended the tag early; and a `}` or
// `{` inside a regex literal moved the brace depth, so
// `<button onClick={() => s.replace(/}/g, '')} title="x" />` escaped. Lexing
// once and letting the walker consider only CODE offsets closes all three.
//
// Template literals are treated as one opaque string span, `${…}` included.
// That is deliberate: an interpolation's braces balance each other, so ignoring
// both halves keeps the tag's brace depth correct, and no JSX opening tag is
// ever authored inside one.
const K_CODE = 0
const K_STRING = 1
const K_COMMENT = 2
const K_REGEX = 3

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
// `start`, or -1 when it does not close on the same line — a regex literal
// cannot span a newline, so bailing there bounds the damage of a `/` this
// heuristic reads wrong to a single line.
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

// Classify every offset as code, comment, string, or regex body. Only CODE
// offsets are structural: everything else is text the tag walk must step over
// without reading a quote, a brace, or a `>` out of it.
function lexKinds(source) {
  const kinds = new Uint8Array(source.length)
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
      const nl = source.indexOf('\n', i)
      const stop = nl === -1 ? source.length : nl
      kinds.fill(K_COMMENT, i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2)
      const stop = close === -1 ? source.length : close + 2
      kinds.fill(K_COMMENT, i, stop)
      i = stop
      continue
    }
    if (ch === '"' || ch === "'") {
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
      kinds.fill(K_STRING, start, stop)
      i = stop
      settle(ch)
      continue
    }
    if (ch === '`') {
      const start = i
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '`') break
        i += 1
      }
      const stop = Math.min(source.length, i + 1)
      kinds.fill(K_STRING, start, stop)
      i = stop
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
        kinds.fill(K_REGEX, i, end)
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

// Walk from a `<` to the `>` that closes the opening tag, respecting brace
// depth so a `>` inside an attribute value does not end the tag. Comment,
// string, and regex offsets are stepped over: their contents are text, and a
// quote, brace or `>` inside them is not structure.
function openingTagEndIndex(source, open, kinds) {
  let depth = 0
  for (let i = open + 1; i < source.length && i - open < 6000; i += 1) {
    if (kinds[i] !== K_CODE) continue
    const ch = source[i]
    if (ch === '{') depth += 1
    // Clamped, never negative. A stray `}` at depth 0 inside an opening tag is
    // malformed markup, and letting the depth go negative meant `>` was never
    // seen at depth 0 again: `<button }} title="x" />` walked off the end and
    // the tag was skipped. Clamping keeps the walk at the tag's own level.
    else if (ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === '<' && depth === 0) return -1
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

// Yields { tagName, titleIndex } for every interactive opening tag carrying a
// native `title=` attribute (attribute position, so a `title:` object key or a
// `title=` inside a nested string does not count). A `<button` written inside a
// comment, a string, or a regex literal is prose or a fixture, not a control,
// and is not scanned at all.
function* nativeTitleOnInteractive(source) {
  const kinds = lexKinds(source)
  INTERACTIVE_TAG_OPEN.lastIndex = 0
  let open
  while ((open = INTERACTIVE_TAG_OPEN.exec(source))) {
    if (kinds[open.index] !== K_CODE) continue
    const end = openingTagEndIndex(source, open.index, kinds)
    if (end < 0) continue
    const tag = source.slice(open.index, end + 1)
    // Attribute position: preceded by whitespace, at brace depth 0 in the tag,
    // and itself code rather than comment / string / regex text.
    const attr = /(?<=\s)title\s*=/g
    let m
    while ((m = attr.exec(tag))) {
      if (kinds[open.index + m.index] !== K_CODE) continue
      let depth = 0
      for (let i = 0; i < m.index; i += 1) {
        if (kinds[open.index + i] !== K_CODE) continue
        const ch = tag[i]
        if (ch === '{') depth += 1
        else if (ch === '}') depth = Math.max(0, depth - 1)
      }
      if (depth === 0) yield { tagName: open[1], titleIndex: open.index + m.index }
    }
    INTERACTIVE_TAG_OPEN.lastIndex = end + 1
  }
}

// Baselined files still hold legacy native dialog calls that are scheduled for
// migration in the app-wide audit plan. Entries are removed as their owning
// task completes so the guard catches any re-addition.
// Empty: all renderer native-dialog call sites have been migrated to the
// shared ConfirmDialog flow.
const NATIVE_DIALOG_BASELINE = new Map([])

// no-ad-hoc-icon-size: flag <svg ... className="...h-3 w-3 / h-3.5 w-3.5 /
// h-4 w-4 / h-[Npx] w-[Npx] ..." ...> opening tags. App-shell icons should use
// the canonical `.icon-xs / .icon-sm / .icon-md / .icon-lg` utility classes
// (12/14/16/20 px) or set width/height through CSS variables that resolve to
// `--icon-*`. StatusDot (6 px contract), brand marks, memory-graph canvas
// glyphs, and ANSI terminal output are intentionally not in this vocabulary
// and stay as documented exceptions. The regex matches a single `<svg ...>`
// opening tag whose body contains an ad-hoc paired height+width literal.
// Allow either the standard Tailwind values or arbitrary `h-[…px]` values.
const SVG_TAG = /<svg\b[^>]*?>/gs
const AD_HOC_ICON_SIZE_INSIDE_TAG =
  /\bh-(?:3|3\.5|4|\[[\d.]+(?:px|rem|em)?\])\s+w-(?:3|3\.5|4|\[[\d.]+(?:px|rem|em)?\])\b/

// Baselined ad-hoc icon-size counts per file. T25 drained the renderer tree
// of every h-3 w-3 / h-3.5 w-3.5 / h-4 w-4 / h-[Npx] w-[Npx] svg literal so
// this map is intentionally empty: any new ad-hoc icon size anywhere in the
// renderer is a violation. StatusDot keeps its own 6 px contract; brand
// marks (PATH_EXEMPTIONS), memory graph canvas glyphs (PATH_EXEMPTIONS), and
// ANSI terminal output (PATH_EXEMPTIONS) are out of this vocabulary by
// design and are handled through the file-level exemption list, not here.
const AD_HOC_ICON_SIZE_BASELINE = new Map([])

const RULES = {
  hex: { regex: HEX_LITERAL, name: 'no-inline-hex' },
  tracking: { regex: UPPERCASE_TRACKING, name: 'no-uppercase-tracking' },
  radial: { regex: RADIAL_GRADIENT, name: 'no-radial-gradient' },
  gradient: { regex: BG_GRADIENT_TO, name: 'no-bg-gradient-to' },
  inlineDot: { regex: INLINE_STATUS_DOT, name: 'no-inline-status-dot' },
  glowShadow: { regex: GLOW_SHADOW, name: 'no-glow-shadow' },
}

// path -> rule name -> how many occurrences the entry pays for.
const exemptionByPath = new Map()
for (const entry of PATH_EXEMPTIONS) {
  // An entry naming a file that is gone is how the list rots: it reads as
  // considered, and it protects nothing. It is also the state two of these
  // entries were found in.
  if (!existsSync(resolve(process.cwd(), entry.path))) {
    process.stderr.write(`PATH_EXEMPTIONS names ${entry.path}, which does not exist. Delete the entry.\n`)
    process.exit(2)
  }
  const caps = new Map()
  for (const rule of entry.rules) {
    const declared = entry.max?.[rule]
    if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
      process.stderr.write(
        `PATH_EXEMPTIONS entry for ${entry.path} exempts \`${rule}\` without declaring ` +
          '`max` for it. An exemption with no number is a blanket one: it hides every future ' +
          'occurrence in that file as well as the ones it was written for. Declare the measured ' +
          'count.\n',
      )
      process.exit(2)
    }
    caps.set(rule, declared)
  }
  exemptionByPath.set(entry.path, caps)
}

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')
const QUIET = args.has('--quiet')

function walkComponents(absoluteRoot, repoRoot) {
  const out = []
  if (!existsSync(absoluteRoot)) return out
  const entries = readdirSync(absoluteRoot, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...walkComponents(full, repoRoot))
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      const ext = entry.name.slice(dot)
      if (!ALLOWED_EXT.has(ext)) continue
      const relative = full
        .slice(repoRoot.length + 1)
        .split(sep)
        .join('/')
      out.push(relative)
    }
  }
  return out
}

/**
 * Blank out comment bodies, preserving every offset and newline.
 *
 * The rule regexes used to run over the raw line, so a comment DESCRIBING a
 * forbidden pattern counted as one — writing "we avoid shadow-[0_0_0_…] here"
 * failed the gate, which meant documenting a rule made the rule look broken and
 * deleting the documentation "fixed" it. Comments are prose about the code, not
 * the code.
 *
 * Replacement is space-for-character rather than deletion so `line` and
 * `column` in every finding still point at the real source, and so the
 * `design-tokens-allow:` marker scan — which reads the RAW lines, because the
 * markers live in comments — keeps lining up with it.
 *
 * String literals are tracked so a `//` inside `'https://…'` is not mistaken
 * for a comment. Template literals may contain `${}` with nested quotes; the
 * cost of getting that wrong is only that a comment goes unmasked (a false
 * positive that was the status quo), never that real code is blanked.
 */
function maskComments(source) {
  const out = source.split('')
  let i = 0
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' '
        i += 1
      }
      // The closing `*/` itself.
      if (i < source.length) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    i += 1
  }
  return out.join('')
}

const repoRoot = process.cwd()
const scanRootAbs = resolve(repoRoot, SCAN_ROOT)
const TARGET_FILES = walkComponents(scanRootAbs, repoRoot).sort()

let totalViolations = 0
const perFile = []

for (const relativePath of TARGET_FILES) {
  const fullPath = resolve(repoRoot, relativePath)
  const source = readFileSync(fullPath, 'utf8')
  const lines = source.split('\n')
  // Same offsets, comment bodies blanked. `lines` stays raw for the
  // allow-marker scan (markers live in comments); the RULES regexes run over
  // this so prose about a pattern is not counted as the pattern.
  const codeLines = maskComments(source).split('\n')
  const fileExemptCaps = exemptionByPath.get(relativePath) ?? new Map()
  // How many occurrences of each exempted rule this file has actually spent.
  // Occurrences up to the cap are suppressed; the rest are ordinary violations,
  // and a cap left above what the file spends is itself a finding.
  const exemptSpend = new Map()
  function exemptAbsorbs(ruleName) {
    if (!fileExemptCaps.has(ruleName)) return false
    const spent = (exemptSpend.get(ruleName) ?? 0) + 1
    exemptSpend.set(ruleName, spent)
    return spent <= fileExemptCaps.get(ruleName)
  }
  const counts = {
    hex: 0,
    tracking: 0,
    radial: 0,
    gradient: 0,
    inlineDot: 0,
    glowShadow: 0,
    statusdotFromAppIcons: 0,
    nativeDialog: 0,
    nativeTitleOnInteractive: 0,
    adHocIconSize: 0,
  }
  const findings = []

  // File-scoped check for StatusDot-from-AppIcons. It is intentionally NOT
  // honourable via PATH_EXEMPTIONS — there is no legitimate reason to import
  // the deleted alias.
  STATUSDOT_FROM_APP_ICONS.lastIndex = 0
  let importMatch
  while ((importMatch = STATUSDOT_FROM_APP_ICONS.exec(source))) {
    counts.statusdotFromAppIcons += 1
    const upTo = source.slice(0, importMatch.index)
    const lineNumber = upTo.split('\n').length
    const lastNewline = upTo.lastIndexOf('\n')
    const column = importMatch.index - lastNewline
    findings.push({
      rule: 'no-statusdot-from-app-icons',
      line: lineNumber,
      column,
      text: importMatch[0].split('\n')[0],
    })
  }

  NATIVE_DIALOG.lastIndex = 0
  let nativeDialogMatch
  while ((nativeDialogMatch = NATIVE_DIALOG.exec(source))) {
    counts.nativeDialog += 1
    const upTo = source.slice(0, nativeDialogMatch.index)
    const lineNumber = upTo.split('\n').length
    const lastNewline = upTo.lastIndexOf('\n')
    const column = nativeDialogMatch.index - lastNewline
    findings.push({
      rule: 'no-native-window-dialog',
      line: lineNumber,
      column,
      text: nativeDialogMatch[0],
    })
  }

  // File-scoped check for ad-hoc icon sizing inside <svg ...> opening tags.
  // The SVG_TAG regex tolerates multi-line tag bodies; the inner check fires
  // when the tag carries one of the legacy h-N w-N pairs. Per-line
  // `design-tokens-allow:` markers honour the exemption when an SVG truly
  // needs a non-canonical size (rare). The baseline is tallied per file; any
  // count above baseline is a violation.
  {
    SVG_TAG.lastIndex = 0
    let svgMatch
    while ((svgMatch = SVG_TAG.exec(source))) {
      const tagText = svgMatch[0]
      if (!AD_HOC_ICON_SIZE_INSIDE_TAG.test(tagText)) continue
      const upTo = source.slice(0, svgMatch.index)
      const lineNumber = upTo.split('\n').length
      const lastNewline = upTo.lastIndexOf('\n')
      const column = svgMatch.index - lastNewline
      const lineText = lines[lineNumber - 1] ?? ''
      const prev1 = lineNumber >= 2 ? (lines[lineNumber - 2] ?? '') : ''
      const prev2 = lineNumber >= 3 ? (lines[lineNumber - 3] ?? '') : ''
      if (lineText.includes(ALLOW_MARKER) || prev1.includes(ALLOW_MARKER) || prev2.includes(ALLOW_MARKER)) {
        continue
      }
      if (exemptAbsorbs('no-ad-hoc-icon-size')) continue
      counts.adHocIconSize += 1
      findings.push({
        rule: 'no-ad-hoc-icon-size',
        line: lineNumber,
        column,
        text: '<svg ... h-N w-N>',
      })
    }
  }

  // File-scoped check for native `title=` on interactive controls. JSX
  // opening tags can span multiple lines so the regex scans the whole source
  // string. The line/column reported point at the offending `title=` token
  // (not the tag opening) so the developer lands on the violation. Per-line
  // `design-tokens-allow:` markers and `PATH_EXEMPTIONS` honour the
  // exemption.
  {
    for (const titleMatch of nativeTitleOnInteractive(source)) {
      const titleIndex = titleMatch.titleIndex
      const upTo = source.slice(0, titleIndex)
      const lineNumber = upTo.split('\n').length
      const lastNewline = upTo.lastIndexOf('\n')
      const column = titleIndex - lastNewline
      const lineText = lines[lineNumber - 1] ?? ''
      const prev1 = lineNumber >= 2 ? (lines[lineNumber - 2] ?? '') : ''
      const prev2 = lineNumber >= 3 ? (lines[lineNumber - 3] ?? '') : ''
      if (lineText.includes(ALLOW_MARKER) || prev1.includes(ALLOW_MARKER) || prev2.includes(ALLOW_MARKER)) {
        continue
      }
      if (exemptAbsorbs('no-native-tooltip-on-control')) continue
      counts.nativeTitleOnInteractive += 1
      findings.push({
        rule: 'no-native-tooltip-on-control',
        line: lineNumber,
        column,
        text: `<${titleMatch.tagName} ... title=`,
      })
    }
  }

  // Compute block-marker mask: `design-tokens-allow-block: <reason>` opens an
  // exempt range that runs until the next `design-tokens-allow-end`. Used for
  // grouped semantic literal blocks (file-type chip palette, etc.) where
  // per-line markers would be noisy.
  const blockOpenMarker = 'design-tokens-allow-block:'
  const blockEndMarker = 'design-tokens-allow-end'
  const blockMask = new Uint8Array(lines.length)
  let inBlock = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!inBlock && line.includes(blockOpenMarker)) inBlock = true
    if (inBlock) blockMask[i] = 1
    if (inBlock && line.includes(blockEndMarker)) inBlock = false
  }

  lines.forEach((line, index) => {
    if (blockMask[index]) return
    if (line.includes(ALLOW_MARKER)) return
    // Accept a marker within the immediately preceding 2 lines — JSX className
    // strings cannot host `//` comments inline, so the conventional placement
    // is a JS comment one or two lines above the violating attribute (often
    // directly above the opening tag of a multi-line element). Two lines is
    // tight enough to keep markers visually adjacent to the violation.
    if (index > 0 && lines[index - 1].includes(ALLOW_MARKER)) return
    if (index > 1 && lines[index - 2].includes(ALLOW_MARKER)) return
    const lineNumber = index + 1

    for (const [key, rule] of Object.entries(RULES)) {
      rule.regex.lastIndex = 0
      let match
      while ((match = rule.regex.exec(codeLines[index] ?? ''))) {
        if (exemptAbsorbs(rule.name)) continue
        counts[key] += 1
        findings.push({
          rule: rule.name,
          line: lineNumber,
          column: match.index + 1,
          text: match[0],
        })
      }
    }
  })

  // A cap left above what the file actually spends is the blanket exemption
  // growing back: the unspent headroom is where the next literal lands unseen.
  // Report it, and name the number to write.
  let staleCaps = 0
  for (const [ruleName, cap] of fileExemptCaps) {
    const spent = exemptSpend.get(ruleName) ?? 0
    if (spent >= cap) continue
    staleCaps += 1
    findings.push({
      rule: 'exemption-cap-stale',
      line: 1,
      column: 1,
      text:
        `PATH_EXEMPTIONS max['${ruleName}'] is ${cap}, the file has ${spent} — write ${spent}` +
        (spent === 0 ? ` (or drop '${ruleName}' from the entry, and the entry with its last rule)` : ''),
    })
  }

  const nativeDialogAllowed = NATIVE_DIALOG_BASELINE.get(relativePath) ?? 0
  const nativeDialogViolations = Math.max(0, counts.nativeDialog - nativeDialogAllowed)
  const adHocIconSizeAllowed = AD_HOC_ICON_SIZE_BASELINE.get(relativePath) ?? 0
  const adHocIconSizeViolations = Math.max(0, counts.adHocIconSize - adHocIconSizeAllowed)
  const fileTotal =
    counts.hex +
    counts.tracking +
    counts.radial +
    counts.gradient +
    counts.inlineDot +
    counts.glowShadow +
    counts.statusdotFromAppIcons +
    counts.nativeTitleOnInteractive +
    nativeDialogViolations +
    adHocIconSizeViolations +
    staleCaps
  perFile.push({
    path: relativePath,
    counts,
    total: fileTotal,
    nativeDialogAllowed,
    adHocIconSizeAllowed,
  })
  totalViolations += fileTotal

  const visibleFindings = findings.filter((finding) => {
    if (finding.rule === 'no-native-window-dialog') return nativeDialogViolations > 0
    if (finding.rule === 'no-ad-hoc-icon-size') return adHocIconSizeViolations > 0
    return true
  })
  if (!QUIET && visibleFindings.length > 0) {
    visibleFindings.sort((a, b) => a.line - b.line || a.column - b.column)
    process.stdout.write(`\n${relativePath}\n`)
    for (const finding of visibleFindings) {
      process.stdout.write(`  ${finding.line}:${finding.column}  ${finding.rule}  ${finding.text}\n`)
    }
  }
}

// When the file-level allow-list outgrows the documented ceiling, surface it as
// a meta-finding so a reviewer notices.
let metaViolations = 0
if (PATH_EXEMPTIONS.length > ALLOW_LIST_CEILING) {
  metaViolations = 1
  process.stdout.write(
    `\n[meta] PATH_EXEMPTIONS has ${PATH_EXEMPTIONS.length} entries; ` +
      `documented ceiling is ${ALLOW_LIST_CEILING}. ` +
      'Drain chrome rather than allow-list it.\n',
  )
}

// CSS scan for src/renderer/src/assets/index.css.
//
// Themable surface chrome lives inside `:root` and `:root[data-theme="..."]`
// blocks. Any hex color literal outside those blocks is a regression that
// would freeze a color into one theme — exactly what the multi-theme rollout
// was meant to prevent. The exception is documented semantic literals (status
// flashes, tab-highlight user palette, brand-gold needs-input chrome, git
// gutter glyphs); each line that needs an exception carries the same
// `design-tokens-allow:` marker the component scan honours.
const THEME_CSS_PATH = 'src/renderer/src/assets/index.css'
const CSS_HEX_LITERAL = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g
// Match any `:root` selector list — bare `:root`, `:root[data-theme="…"]`,
// or comma-joined combinations. Captures up to and including the opening
// brace so the brace walker below picks up the block body.
const ROOT_SELECTOR =
  /:root(?:\s*\[data-theme\s*=\s*"[a-zA-Z0-9_-]+"\])?(?:\s*,\s*:root(?:\s*\[data-theme\s*=\s*"[a-zA-Z0-9_-]+"\])?)*\s*\{/g
let cssViolations = 0
const cssFindings = []
const cssAbsPath = resolve(repoRoot, THEME_CSS_PATH)
if (existsSync(cssAbsPath)) {
  const cssSource = readFileSync(cssAbsPath, 'utf8')
  const cssLines = cssSource.split('\n')
  // Mark every offset that sits inside a `:root[data-theme=...]` block. We
  // detect those blocks by selector regex and then walk the brace depth to
  // find the matching closing brace. Any hex outside this masked range is a
  // candidate violation.
  const allowMask = new Uint8Array(cssSource.length)
  // Mask every offset inside a `/* … */` block comment so doc references
  // (e.g. `#hex` cited inside a `:root[data-theme="conifer"]` header comment)
  // don't trip the guard.
  {
    let i = 0
    while (i < cssSource.length - 1) {
      if (cssSource[i] === '/' && cssSource[i + 1] === '*') {
        const start = i
        i += 2
        while (i < cssSource.length - 1 && !(cssSource[i] === '*' && cssSource[i + 1] === '/')) {
          i += 1
        }
        const end = Math.min(cssSource.length, i + 2)
        for (let j = start; j < end; j += 1) allowMask[j] = 1
        i = end
      } else {
        i += 1
      }
    }
  }
  ROOT_SELECTOR.lastIndex = 0
  let rootMatch
  while ((rootMatch = ROOT_SELECTOR.exec(cssSource))) {
    const openBrace = rootMatch.index + rootMatch[0].length - 1
    let depth = 1
    let i = openBrace + 1
    while (i < cssSource.length && depth > 0) {
      const ch = cssSource[i]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
    const close = i
    for (let j = openBrace; j < close; j += 1) allowMask[j] = 1
  }
  // Block-marker support: a `design-tokens-allow-block:` line opens an
  // exception zone that runs until the next `design-tokens-allow-end` line.
  // Used for grouped semantic literal blocks (tab-highlight palette,
  // git/markdown gutter palette) where per-line markers would be noisy.
  {
    const blockOpen = 'design-tokens-allow-block:'
    const blockEnd = 'design-tokens-allow-end'
    let pos = 0
    while (pos < cssSource.length) {
      const openIdx = cssSource.indexOf(blockOpen, pos)
      if (openIdx === -1) break
      const endIdx = cssSource.indexOf(blockEnd, openIdx + blockOpen.length)
      const stop = endIdx === -1 ? cssSource.length : endIdx + blockEnd.length
      for (let j = openIdx; j < stop; j += 1) allowMask[j] = 1
      pos = stop
    }
  }
  CSS_HEX_LITERAL.lastIndex = 0
  let hexMatch
  while ((hexMatch = CSS_HEX_LITERAL.exec(cssSource))) {
    if (allowMask[hexMatch.index]) continue
    const upTo = cssSource.slice(0, hexMatch.index)
    const lineNumber = upTo.split('\n').length
    const lineText = cssLines[lineNumber - 1] ?? ''
    const prev1 = lineNumber >= 2 ? (cssLines[lineNumber - 2] ?? '') : ''
    const prev2 = lineNumber >= 3 ? (cssLines[lineNumber - 3] ?? '') : ''
    if (lineText.includes(ALLOW_MARKER) || prev1.includes(ALLOW_MARKER) || prev2.includes(ALLOW_MARKER)) {
      continue
    }
    const lastNewline = upTo.lastIndexOf('\n')
    const column = hexMatch.index - lastNewline
    cssFindings.push({
      rule: 'no-themable-hex-outside-root',
      line: lineNumber,
      column,
      text: hexMatch[0],
    })
    cssViolations += 1
  }
  if (!QUIET && cssFindings.length > 0) {
    cssFindings.sort((a, b) => a.line - b.line || a.column - b.column)
    process.stdout.write(`\n${THEME_CSS_PATH}\n`)
    for (const finding of cssFindings) {
      process.stdout.write(`  ${finding.line}:${finding.column}  ${finding.rule}  ${finding.text}\n`)
    }
  }
  totalViolations += cssViolations
}

process.stdout.write('\nDesign-token guard summary\n')
process.stdout.write(`  scope: ${SCAN_ROOT} (recursive, .tsx/.ts, ${TARGET_FILES.length} files)\n`)
process.stdout.write(`  allow-list: ${PATH_EXEMPTIONS.length}/${ALLOW_LIST_CEILING} file-level exemptions\n`)
const dirty = perFile.filter((entry) => entry.total > 0)
if (!QUIET) {
  for (const entry of dirty) {
    const {
      hex,
      tracking,
      radial,
      gradient,
      inlineDot,
      glowShadow,
      statusdotFromAppIcons,
      nativeDialog,
      nativeTitleOnInteractive,
      adHocIconSize,
    } = entry.counts
    process.stdout.write(
      `  ${entry.path}: hex=${hex} uppercase-tracking=${tracking} radial-gradient=${radial} bg-gradient-to=${gradient} inline-status-dot=${inlineDot} glow-shadow=${glowShadow} statusdot-from-app-icons=${statusdotFromAppIcons} native-dialog=${nativeDialog}/${entry.nativeDialogAllowed} native-tooltip-on-control=${nativeTitleOnInteractive} ad-hoc-icon-size=${adHocIconSize}/${entry.adHocIconSizeAllowed}\n`,
    )
  }
}
process.stdout.write(`Total violations: ${totalViolations}\n`)

if (totalViolations > 0) {
  process.stdout.write(
    '\nFix by reading colors from CSS variables in src/renderer/src/assets/index.css,\n' +
      'dropping uppercase tracking chrome in favor of sentence-case labels,\n' +
      'replacing radial-gradient / bg-gradient-to-* decoration with solid\n' +
      'token-backed backgrounds, reusing the ui/StatusDot primitive\n' +
      'instead of the deleted AppIcons re-export, replacing native renderer\n' +
      'dialogs with ConfirmDialog/useConfirmDialog, and wrapping interactive\n' +
      'controls (button, a, IconButton, PrimaryButton, GhostButton) with the\n' +
      'ui/Tooltip primitive instead of relying on the native title attribute.\n' +
      'Document intentional exceptions with `// design-tokens-allow: <reason>`\n' +
      'on the same line, or in PATH_EXEMPTIONS with a category-naming comment\n' +
      'AND a measured `max` count — an exemption with no number admits every\n' +
      'literal that file ever gains.\n',
  )
}

// CI safety: if the component tree is missing entirely (wrong cwd or the
// folder was renamed) the guard would otherwise silently pass with zero
// violations. Fail explicitly so misconfiguration is visible.
if (TARGET_FILES.length === 0) {
  process.stdout.write(
    `\nNo component files found under ${SCAN_ROOT}. Run this from the repo\n` +
      'root or update SCAN_ROOT in scripts/lint-design-tokens.mjs if the\n' +
      'component tree moved.\n',
  )
  process.exit(2)
}

const exitCode = !REPORT_ONLY && totalViolations + metaViolations > 0 ? 1 : 0
process.exit(exitCode)
