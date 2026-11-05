// The starting points the new-agent tab offers.
//
// A card is a launch button: one click spawns the agent shown above it with the
// entry's `prompt` as its startup prompt. So the prompt is the real thing — the
// title is a label for a button, and never what gets sent. Each prompt names its
// scope, where findings go, and the boundary that keeps a survey from turning
// into an unrequested refactor.
//
// Pure and React-free: the draw is a function of a seed, so a test can pin it
// and a re-render cannot reshuffle what someone is reading.

/** Grouping used to keep one draw from being eight flavours of the same idea. */
export type SuggestionCategory =
  'review' | 'design' | 'performance' | 'security' | 'tests' | 'backlog' | 'docs' | 'deps'

export type SuggestionEntry = {
  id: string
  category: SuggestionCategory
  /** Verb-first, the task in the user's terms. Not the prompt. */
  title: string
  /** One line of what the agent will actually do. */
  description: string
  /**
   * What the run leaves behind — the one fact a person cannot infer from the
   * title, and the reason these are worth a click.
   */
  outcome: string
  /** What is actually sent. Complete on its own: an agent gets no other brief. */
  prompt: string
}

// The instruction every survey-shaped card ends with. Written once: a card that
// quietly starts fixing things is a different (and much larger) action than the
// one the user pressed.
const FILE_DONT_FIX = [
  'Do not fix anything you find. This pass produces a written record, not a change:',
  'file one Backlog item per finding with `backlog.create` (or, without that tool, a markdown',
  'file under `backlog/`), each naming the file and the behaviour, why it matters, and what',
  'would resolve it. If a finding is too small to be worth an item, leave it out rather than',
  'filing noise. Report the count and the titles when you finish.',
].join(' ')

export const SUGGESTION_BANK: readonly SuggestionEntry[] = [
  {
    id: 'review-codebase',
    category: 'review',
    title: 'Review the codebase',
    description: 'A deep pass over the repo for correctness, dead code, and drift between modules.',
    outcome: 'Files backlog items',
    prompt: [
      'Review this codebase and report what is wrong with it.',
      'Work outward from the entry points: read the module boundaries, then the code behind them.',
      'Look for correctness bugs, unreachable or dead code, duplicated logic that has drifted apart,',
      'and contracts that two callers understand differently. Prefer a small number of real findings',
      'over a long list of style opinions.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'review-recent-commits',
    category: 'review',
    title: 'Review the last week of commits',
    description: 'What landed, what it broke, and what it left half-done.',
    outcome: 'Files backlog items',
    prompt: [
      'Review what landed in this repo over the last seven days.',
      'Read the commits and their diffs, then judge the result rather than the intent: what works,',
      'what regressed, and what was left half-finished behind a flag, a TODO, or an unused export.',
      'Pay attention to changes that touched a shared contract without updating every caller.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'design-system-audit',
    category: 'design',
    title: 'Audit the UI against the design system',
    description: 'Find where surfaces drift from the design system — tokens, spacing, states.',
    outcome: 'Files backlog items',
    prompt: [
      "Audit this app's UI against its design system.",
      'Read the design system bundle first (its usage contract, tokens, and component specs), then',
      "the app's surfaces. Report where the app drifts: hard-coded colours, spacing off the scale,",
      'a component rebuilt instead of reused, a state (hover, focus-visible, disabled, empty, error)',
      'the spec requires and the surface does not draw.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'copy-voice-audit',
    category: 'design',
    title: 'Check the copy against the voice rules',
    description: 'Every user-visible string in one surface, judged against the voice guide.',
    outcome: 'Files backlog items',
    prompt: [
      "Check this app's user-visible copy against its documented voice rules.",
      'Find the voice guide in the repo and follow it exactly rather than your own preferences.',
      'Collect the strings a person actually sees — labels, empty states, errors, tooltips — and',
      'report the ones that break a rule, quoting the string, its file, and the rule it breaks.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'performance-problems',
    category: 'performance',
    title: 'Find performance problems',
    description: 'Profile the slow paths — render, IPC, startup — and name the cost of each.',
    outcome: 'Files backlog items',
    prompt: [
      "Find this application's real performance problems.",
      'Start from what a user waits for: startup, the first paint of each main surface, and any',
      'interaction that blocks. Read the hot paths rather than guessing — repeated work per render,',
      'unbounded lists, synchronous I/O on the UI thread, chatty IPC, work done on every keystroke.',
      'For each finding, name the cost in terms a person would notice, and say how you established it.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'unused-weight',
    category: 'performance',
    title: 'Find what the app loads and never uses',
    description: 'Bundle weight, dead imports, and assets that ship without being read.',
    outcome: 'Files backlog items',
    prompt: [
      'Find what this app pays to load and never uses.',
      'Look for modules pulled into a bundle by a single unused export, dependencies imported for',
      'one helper, assets that ship but are never referenced, and polyfills for platforms this app',
      'does not target. Say what each one costs and what removing it would risk.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'security-review',
    category: 'security',
    title: 'Review the app for security holes',
    description: 'The IPC surface, file access, and credential handling.',
    outcome: 'Files backlog items',
    prompt: [
      'Review this application for security weaknesses.',
      'Concentrate on the boundaries: what the renderer can ask the main process to do, what paths',
      'a handler will accept, where user input reaches a shell or a file path, how credentials are',
      'stored and whether any reach a log or argv. Judge what an attacker could actually do, not',
      'what is theoretically imperfect.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'untested-paths',
    category: 'tests',
    title: 'Find the untested paths',
    description: 'What the suite claims to cover, and what it actually runs.',
    outcome: 'Files backlog items',
    prompt: [
      'Find the parts of this codebase the test suite does not actually exercise.',
      'Read what the suite runs, then compare it against the code that carries real risk: error',
      'paths, state transitions, and the contracts between modules. A file with a test is not a',
      'file that is covered — say which BEHAVIOUR is untested, and what a test for it would assert.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'flaky-tests',
    category: 'tests',
    title: 'Hunt flaky tests',
    description: 'The ones that pass on retry and hide a real race.',
    outcome: 'Files backlog items',
    prompt: [
      'Hunt for flaky tests in this repo.',
      'Look for the shapes that produce them: real timers, fixed sleeps, shared mutable fixtures,',
      'order-dependent state, unawaited promises, and assertions on wall-clock time. Where you can,',
      'run a suspect test repeatedly to confirm. A flaky test usually names a real race in the code',
      'underneath — say which, when you can tell.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'triage-backlog',
    category: 'backlog',
    title: 'Triage the backlog',
    description: 'Read every open item, merge duplicates, and rank what to pick up next.',
    outcome: 'Updates backlog items',
    prompt: [
      "Triage this project's backlog.",
      'Read every non-archived item and judge it against the code as it is today: still worth doing,',
      'already built, overtaken by another change, or simply mis-statused. Duplicates should be',
      'merged into the better-written item rather than both left open.',
      'Report your findings grouped, with a one-line reason and a proposed action each, and change',
      'nothing until the user has approved the list. If you cannot tell whether an item still',
      'matters, say so rather than guessing it away.',
    ].join('\n'),
  },
  {
    id: 'docs-drift',
    category: 'docs',
    title: 'Check the docs against the code',
    description: 'Where the written record and the repo disagree.',
    outcome: 'Files backlog items',
    prompt: [
      "Check this project's documentation against the code it describes.",
      'Read the docs and knowledge files, then verify their claims: named files that moved, flags',
      'that were renamed, flows that now work differently, and instructions that would fail if',
      'followed today. Quote the passage and name what is actually true.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
  {
    id: 'dependency-audit',
    category: 'deps',
    title: 'Audit dependencies',
    description: 'What is outdated, unused, or duplicated across the tree.',
    outcome: 'Files backlog items',
    prompt: [
      "Audit this project's dependencies.",
      'Report what is unused, what is duplicated at conflicting versions, what is badly out of date,',
      'and what is a heavyweight dependency doing a job the platform now does. For each, say what',
      'upgrading or removing it would take and what it would risk breaking.',
      FILE_DONT_FIX,
    ].join('\n'),
  },
]

/** How many cards the surface shows. */
export const SUGGESTION_DRAW_SIZE = 8

// A tiny deterministic PRNG (mulberry32). The draw must be stable for the life
// of a tab — a re-render that reshuffled the cards would move what someone is
// already reading — so the surface seeds once and holds the result.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pick the cards for one tab: category-spread first (one per category, in a
 * shuffled category order) so a draw never reads as eight flavours of "review
 * the code", then topped up from what is left if the bank ever has fewer
 * categories than the draw size.
 *
 * Deterministic in `seed` — same seed, same cards, in the same order.
 */
export function drawSuggestions(
  seed: number,
  count: number = SUGGESTION_DRAW_SIZE,
  bank: readonly SuggestionEntry[] = SUGGESTION_BANK,
): SuggestionEntry[] {
  if (count <= 0 || bank.length === 0) return []
  const random = seededRandom(seed)

  const shuffle = <T>(items: T[]): T[] => {
    const next = [...items]
    for (let i = next.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      ;[next[i], next[j]] = [next[j], next[i]]
    }
    return next
  }

  const byCategory = new Map<SuggestionCategory, SuggestionEntry[]>()
  for (const entry of bank) {
    const bucket = byCategory.get(entry.category)
    if (bucket) bucket.push(entry)
    else byCategory.set(entry.category, [entry])
  }

  const picked: SuggestionEntry[] = []
  const takenIds = new Set<string>()
  for (const category of shuffle([...byCategory.keys()])) {
    if (picked.length >= count) break
    const [entry] = shuffle(byCategory.get(category) ?? [])
    if (!entry) continue
    picked.push(entry)
    takenIds.add(entry.id)
  }

  // Only reached when the bank has fewer categories than the draw size; keeps
  // the surface full rather than rendering a short grid.
  if (picked.length < count) {
    for (const entry of shuffle(bank.filter((candidate) => !takenIds.has(candidate.id)))) {
      if (picked.length >= count) break
      picked.push(entry)
      takenIds.add(entry.id)
    }
  }

  return picked
}

/** A seed for a fresh draw. Callers hold the value so the draw stays put. */
export function newSuggestionSeed(): number {
  return Math.floor(Math.random() * 0xffffffff)
}
