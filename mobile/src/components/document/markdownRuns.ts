// A reply's Markdown cut along its top-level blocks (paragraphs, lists,
// fences, tables, quotes, headings) into runs of a few blocks, each run the
// exact source lines it spans. A reply streams in one delta at a time and
// only ever grows at its end, so every run but the last is already final:
// drawn one Markdown per run, a delta parses and draws only the last run,
// where drawing the whole reply again made each delta cost more than the one
// before. Runs rather than single blocks, so a long reply mounts a few
// Markdowns rather than one per paragraph; and a reply too short to need
// cutting is one run without being parsed for its blocks, so it costs what
// it did.
//
// Each run parses alone as it did inside the whole: block parsing reads line
// by line and nothing at the top level looks back past a block's start. The
// exception is a reference definition (`[label]: url`), which defines links
// for every block, so a reply that holds one is not cut.

/** The block tokens markdown-it's block parser emits: enough to find the top level. */
type BlockToken = { level: number; nesting: number; map: [number, number] | null };
/** A markdown-it instance, as far as its block parser goes. */
export type BlockParser = {
  block: { parse(source: string, md: unknown, env: Record<string, unknown>, out: BlockToken[]): void };
};

/** How many top-level blocks a run holds. */
export const BLOCKS_PER_RUN = 8;
/** Below this many characters a reply is drawn whole: parsing it again is cheaper than finding its blocks. */
export const RUNS_FROM_LENGTH = 1_000;

/** markdown-it's own normalisation, so line numbers match the source it parses. */
const normalize = (source: string) => source.replace(/\r\n?|\n/g, "\n").replace(/\0/g, "�");

/**
 * The source of each run of top-level blocks, in order. A short body, one
 * with a reference definition, or one with no blocks is one run: the body.
 */
export function markdownRuns(
  body: string,
  parser: BlockParser,
  { perRun = BLOCKS_PER_RUN, fromLength = RUNS_FROM_LENGTH }: { perRun?: number; fromLength?: number } = {},
): string[] {
  if (body.length < fromLength) return [body];
  const source = normalize(body);
  const env: Record<string, unknown> = {};
  const tokens: BlockToken[] = [];
  parser.block.parse(source, parser, env, tokens);
  if (env.references !== undefined) return [body];
  const spans: [number, number][] = [];
  for (const token of tokens) if (token.level === 0 && token.nesting !== -1 && token.map) spans.push(token.map);
  if (!spans.length) return [body];
  const lines = source.split("\n");
  const runs: string[] = [];
  for (let first = 0; first < spans.length; first += perRun) {
    const last = Math.min(first + perRun, spans.length) - 1;
    const end = spans[last][1];
    // The line break that ended the run's last line in the whole, where one
    // did: an indented code block keeps it in its content.
    runs.push(lines.slice(spans[first][0], end).join("\n") + (end < lines.length ? "\n" : ""));
  }
  return runs;
}
