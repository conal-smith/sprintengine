// What an agent's reply reads beyond Markdown, as the desktop reads it:
// display math and the fences that draw (```math, ```mermaid).
//
// The risk is not missing a formula but finding one that is not there.
// Agents write prices ("between $5 and $10") and shell variables (`$HOME`) in
// prose all the time, so a dollar never opens math here at all: display math
// is a block of its own, like a code fence, and nothing inline is read as it.
// `$$` opens and closes on lines of their own; `\[` opens a line and `\]`
// ends one, so `\[ E = mc^2 \]` filling a line is a block too. A block needs
// its closing line, so a formula still streaming in is text until it is
// complete. In the middle of a sentence `\[` is the escaped bracket Markdown
// always made it; `\[1\]` on a line of its own is a citation; a `\]` with more
// after it on its line is a sentence's brackets. Being block rules, none of
// this is read inside a code span or a code block.
//
// ```math fences typeset; ```latex, ```tex and ```katex stay code, since
// they are as often whole documents as formulas.
//
// Inline `\( … \)` is found, so it is not mangled into "(…)" by Markdown's
// escapes, and shown as its TeX in a code pill (`MarkdownDocument`'s
// `math_inline`): a React Native text run cannot hold a typeset formula
// without breaking its line around it. It stays on its line, and gives way to
// a backtick or a `://`, which TeX has no use for and code and links do.
//
// Every fence and display block carries `meta.lineBreakAfter`: whether a line
// break follows its closing line in the source parsed. While a reply streams,
// its last block is complete only once one does; a fence closing on the very
// last line might yet turn out to be ```` ```x ```` (`replyBlockReady`).

/** The slice of markdown-it this module drives. */
type StateBlock = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  tokens: { markup: string; meta: unknown }[];
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
  push(type: string, tag: string, nesting: number): { content: string; markup: string; map: number[] | null; block: boolean; meta: unknown };
};
type StateInline = {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): { content: string; markup: string };
};
type BlockRule = (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean;
type InlineRule = (state: StateInline, silent: boolean) => boolean;
export type ReplyMarkdownIt = {
  block: {
    ruler: {
      before(name: string, rule: string, fn: BlockRule, options?: { alt: string[] }): void;
      at(name: string, fn: BlockRule, options?: { alt: string[] }): void;
      __rules__: { name: string; fn: BlockRule; alt: string[] }[];
    };
  };
  inline: { ruler: { before(name: string, rule: string, fn: InlineRule): void } };
};

/** A display formula longer than this is left as the text it is. */
export const MAX_DISPLAY_MATH = 16_384;
/** Inline math longer than this is left as the text it is. */
export const MAX_INLINE_MATH = 4_096;

export type FenceKind = "math" | "diagram" | "code";

/** What a fence's info string asks for: only ```math typesets, ```mermaid (```mmd) draws. */
export function fenceKind(info: string | undefined): FenceKind {
  const language = (info ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (language === "math") return "math";
  if (language === "mermaid" || language === "mmd") return "diagram";
  return "code";
}

export type BlockMeta = { closed: boolean; lineBreakAfter: boolean };

/** Whether a reply's fence or display block may be drawn: always once the reply is final, while it streams only once nothing more can change it. */
export function replyBlockReady(meta: unknown, streaming: boolean): boolean {
  if (!streaming) return true;
  const block = meta as Partial<BlockMeta> | null | undefined;
  return block?.closed === true && block.lineBreakAfter === true;
}

/** `\[1\]`, `\[2, 3\]`, `\[4-6\]`: citations, not equations. */
const CITATION = /^[\d\s,–-]*$/;

const lineText = (state: StateBlock, line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);

const displayMath: BlockRule = (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const opening = lineText(state, startLine);
  const bracket = opening.startsWith("\\[");
  if (!bracket && !opening.startsWith("$$")) return false;
  const rest = opening.slice(2);
  let tex: string;
  let closeLine = startLine;
  if (!bracket) {
    // `$$` alone: `$$$` is a run of dollars, `$$5` a price.
    if (rest.trim() !== "") return false;
    let found = -1;
    for (let line = startLine + 1; line < endLine; line += 1) {
      const start = state.bMarks[line] + state.tShift[line];
      // A line that leaves the container the block opened in ends it, unclosed.
      if (start < state.eMarks[line] && state.sCount[line] < state.blkIndent) break;
      if (state.sCount[line] - state.blkIndent < 4 && lineText(state, line).trim() === "$$") {
        found = line;
        break;
      }
      if (state.eMarks[line] - state.bMarks[startLine + 1] > MAX_DISPLAY_MATH) return false;
    }
    if (found === -1) return false;
    closeLine = found;
    tex = state.getLines(startLine + 1, closeLine, state.blkIndent, false);
  } else {
    const closesOn = (text: string) => /\\\]\s*$/.test(text);
    if (closesOn(rest)) {
      tex = rest.replace(/\\\]\s*$/, "");
      // `\[a\] and \[b\]` is a sentence's brackets, not one formula.
      if (tex.includes("\\]")) return false;
    } else {
      if (rest.includes("\\]")) return false;
      let found = -1;
      for (let line = startLine + 1; line < endLine; line += 1) {
        const start = state.bMarks[line] + state.tShift[line];
        if (start < state.eMarks[line] && state.sCount[line] < state.blkIndent) break;
        const text = lineText(state, line);
        if (closesOn(text)) {
          if (text.replace(/\\\]\s*$/, "").includes("\\]")) return false;
          found = line;
          break;
        }
        if (text.includes("\\]")) return false;
        if (state.eMarks[line] - state.bMarks[startLine] > MAX_DISPLAY_MATH) return false;
      }
      if (found === -1) return false;
      closeLine = found;
      const middle = state.getLines(startLine + 1, closeLine, state.blkIndent, true);
      tex = `${rest}\n${middle}${lineText(state, closeLine).replace(/\\\]\s*$/, "")}`;
    }
    if (CITATION.test(tex)) return false;
  }
  tex = tex.trim();
  if (!tex || tex.length > MAX_DISPLAY_MATH) return false;
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = tex;
  token.markup = bracket ? "\\[" : "$$";
  token.map = [startLine, closeLine + 1];
  token.meta = { closed: true, lineBreakAfter: state.eMarks[closeLine] < state.src.length } satisfies BlockMeta;
  state.line = closeLine + 1;
  return true;
};

const inlineMath: InlineRule = (state, silent) => {
  const { src } = state;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5c || src.charCodeAt(start + 1) !== 0x28) return false;
  let index = start + 2;
  let close = -1;
  while (index < state.posMax && index - start <= MAX_INLINE_MATH + 2) {
    const code = src.charCodeAt(index);
    if (code === 0x0a || code === 0x60) return false;
    if (code === 0x3a && src.startsWith("//", index + 1)) return false;
    if (code === 0x5c) {
      if (src.charCodeAt(index + 1) === 0x29) {
        close = index;
        break;
      }
      // A TeX command or an escaped character: both are content.
      index += 2;
      continue;
    }
    index += 1;
  }
  if (close === -1) return false;
  const tex = src.slice(start + 2, close).trim();
  if (!tex || tex.length > MAX_INLINE_MATH) return false;
  if (!silent) {
    const token = state.push("math_inline", "code", 0);
    token.content = tex;
    token.markup = "\\(";
  }
  state.pos = close + 2;
  return true;
};

/** Whether `line` is a closing fence for `markup`, by CommonMark's own test. */
function closesFence(state: StateBlock, line: number, markup: string): boolean {
  if (state.sCount[line] - state.blkIndent >= 4) return false;
  const text = lineText(state, line);
  const marker = markup[0];
  let count = 0;
  while (text[count] === marker) count += 1;
  return count >= markup.length && text.slice(count).trim() === "";
}

/**
 * Installs the reply rules on a markdown-it instance: display math, inline
 * math, and each fence's `meta` saying whether it closed and whether a line
 * break follows it.
 */
export function installReplyMarkup(md: ReplyMarkdownIt): void {
  md.block.ruler.before("fence", "math_block", displayMath, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.inline.ruler.before("escape", "math_inline", inlineMath);
  const fence = md.block.ruler.__rules__.find((rule) => rule.name === "fence");
  if (!fence) return;
  const original = fence.fn;
  md.block.ruler.at(
    "fence",
    (state, startLine, endLine, silent) => {
      const found = original(state, startLine, endLine, silent);
      if (!found || silent) return found;
      const token = state.tokens[state.tokens.length - 1];
      const last = state.line - 1;
      const closed = last > startLine && closesFence(state, last, token.markup);
      token.meta = { closed, lineBreakAfter: closed && state.eMarks[last] < state.src.length } satisfies BlockMeta;
      return found;
    },
    { alt: fence.alt },
  );
}
