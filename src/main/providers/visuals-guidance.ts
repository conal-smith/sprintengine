/**
 * How an agent whose replies are read in the app's chat shows a chart: a
 * ```visual fence the chat draws in a sandboxed frame (`conversationVisual.tsx`),
 * coloured with the variables its document is given (`VISUAL_VARIABLES`).
 * Said plainly and as a default, because an agent told only that it may draw
 * answers in prose; and short, because it ships with every chat. Only the
 * chat providers send it: in a terminal the same fence is a screenful of markup.
 */
export const VISUALS_INSTRUCTION = [
  'The chat these replies are read in draws a ```visual fenced block as a chart, table or diagram.',
  'When an answer has a trend, a comparison, a distribution or a flow, show it as a chart in one ```visual block, even if not asked: static HTML with inline SVG, and a <style> if needed.',
  'No scripts, and nothing loaded from elsewhere: no remote images, fonts or CSS.',
  'Colour only with var(--chart-1) to var(--chart-8) for series, and var(--fg), var(--fg-muted), var(--border), var(--bg-subtle), var(--positive), var(--negative) and var(--warning) for the rest, so it reads in light and dark.',
  'Give each SVG a fixed pixel height (width="100%" with a viewBox is fine). No vh units, page background, card or outer padding.',
  'Give it a short title and a one-line caption; keep tables to a few rows. Do not restate what it shows in prose afterwards.',
].join('\n')
