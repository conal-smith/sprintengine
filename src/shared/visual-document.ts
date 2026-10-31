// What every ```visual block is drawn with, wherever it is drawn: in the
// chat's frames (`renderer/src/lib/visual/`) and in the hidden window an
// agent previews one in (`main/visual/visual-preview-window.ts`). The size
// cap, the variables a visual colours with, and the stylesheet its document
// opens with.

/**
 * Past this a fence is shown as its source. A chart is a few kilobytes of
 * SVG; one this size is data pasted as markup, and building a frame of it on
 * every appearance change is not worth it.
 */
export const MAX_VISUAL_SOURCE = 256 * 1024

/** Past this a visual's frame stops growing and its document scrolls. */
export const VISUAL_FRAME_MAX_HEIGHT = 900

export const VISUAL_TOO_LARGE = 'the visual is larger than 256 KB'
export const VISUAL_EMPTY = 'the visual has nothing to draw'

/**
 * The names a visual colours and sets type with, and the semantic token each
 * is read from. Short, because an agent writes them; the agent instructions
 * (`VISUALS_INSTRUCTION`, `main/providers/visuals-guidance.ts`) name the same set.
 */
export const VISUAL_VARIABLES: Readonly<Record<string, string>> = {
  '--fg': '--sem-color-text-default',
  '--fg-strong': '--sem-color-text-primary',
  '--fg-muted': '--sem-color-text-muted',
  '--fg-subtle': '--sem-color-text-subtle',
  '--border': '--sem-color-border-default',
  '--border-subtle': '--sem-color-border-subtle',
  '--bg-subtle': '--sem-color-bg-well',
  '--accent': '--sem-color-accent-primary',
  '--positive': '--sem-color-status-good',
  '--negative': '--sem-color-status-danger',
  '--warning': '--sem-color-status-warn',
  '--chart-1': '--sem-color-chart-1',
  '--chart-2': '--sem-color-chart-2',
  '--chart-3': '--sem-color-chart-3',
  '--chart-4': '--sem-color-chart-4',
  '--chart-5': '--sem-color-chart-5',
  '--chart-6': '--sem-color-chart-6',
  '--chart-7': '--sem-color-chart-7',
  '--chart-8': '--sem-color-chart-8',
  '--chart-other': '--sem-color-chart-other',
  '--font': '--sem-font-family-ui',
  '--font-mono': '--sem-font-family-mono',
  '--font-size': '--sem-font-size-body',
  '--font-size-small': '--sem-font-size-meta',
  '--font-size-heading': '--sem-font-size-heading',
}

/** The window's appearance as a visual is drawn in it: its variables' values, and the colour scheme the frame must share. */
export type VisualTheme = { variables: Record<string, string>; colorScheme?: string }

// A token's value goes into a stylesheet: one that could close the rule or
// the element it sits in is left out rather than trusted.
export const UNSAFE_VALUE = /[<>{};]/u

// Sizes the agent instructions assume; the token values replace them.
const FALLBACKS =
  '--font: system-ui, sans-serif; --font-size: 13px; --font-size-small: 12px; --font-size-heading: 14px;'

export function baseStylesheet(theme: VisualTheme): string {
  const variables = Object.entries(theme.variables)
    .filter(([, value]) => !UNSAFE_VALUE.test(value))
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ')
  return [
    `:root { ${FALLBACKS} ${variables}${theme.colorScheme ? ` color-scheme: ${theme.colorScheme};` : ''} }`,
    // Part of the reply, not a page in it: no background or margin of its own.
    // `flow-root` keeps a first heading's margin inside the body, which is
    // what the frame measures.
    'html, body { margin: 0; padding: 0; background: transparent; }',
    'body { display: flow-root; font-family: var(--font); font-size: var(--font-size); line-height: 1.45; color: var(--fg); overflow-wrap: break-word; }',
    'svg, img { max-width: 100%; }',
    // SVG text and shapes otherwise paint black, unreadable in dark mode; a
    // `fill` the visual sets on an element still wins over one inherited, and
    // a drawing that sets its own (`fill="none"`, for strokes) keeps it.
    'svg:not([fill]) { fill: currentColor; }',
    'img { height: auto; }',
    'h1, h2, h3, h4 { margin: 0 0 4px; font-size: var(--font-size-heading); font-weight: 600; color: var(--fg-strong, var(--fg)); }',
    'p { margin: 0 0 8px; }',
    'table { border-collapse: collapse; font-variant-numeric: tabular-nums; }',
    'th, td { padding: 4px 12px 4px 0; text-align: left; border-bottom: 1px solid var(--border-subtle, var(--border)); }',
    'th { font-weight: 600; color: var(--fg-muted); }',
    'a { color: inherit; text-decoration: none; cursor: default; }',
  ].join('\n')
}

/**
 * The theme a visual is drawn in, from a reader of the window's computed
 * tokens: each variable's token, and the root's colour scheme. A value that
 * could break out of the stylesheet is left out.
 */
export function visualThemeFrom(read: (property: string) => string): VisualTheme {
  const variables: Record<string, string> = {}
  for (const [name, token] of Object.entries(VISUAL_VARIABLES)) {
    const value = read(token).trim()
    if (value && !UNSAFE_VALUE.test(value)) variables[name] = value
  }
  // A frame whose scheme differs from its embedder's is painted opaque, so it
  // takes the window's, whatever that is.
  const scheme = read('color-scheme').trim()
  return { variables, ...(scheme && scheme !== 'normal' && !UNSAFE_VALUE.test(scheme) ? { colorScheme: scheme } : {}) }
}
