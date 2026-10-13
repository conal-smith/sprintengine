// A local file link an agent wrote without the `>` that closes its destination.
//
// Models put a path in angle brackets so a space in it does not end the
// destination — `[notes](<docs/release notes.md>)` — and fairly often drop the
// closing bracket: `[CONTRIBUTING.md](<CONTRIBUTING.md)`. CommonMark reads that
// as no link at all, so the reply showed the brackets and the path as literal
// text where the reader expected a file to click. Closing it is safe only where
// the intent is unambiguous: the destination is a path on this machine (no URL
// scheme), the `)` that ends the link is on the same line, and no `<` or `>`
// comes between them. Code, escaped brackets and images are left exactly as
// written.

const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/u
const FENCE_CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
// Two characters at least, so a Windows drive (`C:\…`) still reads as a path.
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/iu

function isLocalPath(destination: string): boolean {
  const trimmed = destination.trim()
  return trimmed !== '' && !trimmed.startsWith('#') && !URL_SCHEME.test(trimmed)
}

function repairLine(line: string): string {
  const opens: number[] = []
  const insertAt: number[] = []
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '`') {
      let run = 1
      while (line[index + run] === '`') run += 1
      // A code span closes on a run of exactly the same length; without one
      // the backticks are text.
      let close = -1
      for (let at = index + run; at < line.length && close === -1;) {
        let length = 0
        while (line[at + length] === '`') length += 1
        if (length === run) close = at
        at += Math.max(length, 1)
      }
      index = close === -1 ? index + run - 1 : close + run - 1
      continue
    }
    if (char === '[') {
      opens.push(index)
      continue
    }
    if (char !== ']') continue
    const open = opens.pop()
    if (open === undefined || !line.startsWith('(<', index + 1)) continue
    if (line[open - 1] === '!') continue
    const start = index + 3
    let end = start
    while (end < line.length && !'<>)'.includes(line[end])) end += 1
    if (line[end] !== ')' || !isLocalPath(line.slice(start, end))) continue
    insertAt.push(end)
    index = end
    // A link cannot hold another, so no bracket before it can still open one.
    opens.length = 0
  }
  if (insertAt.length === 0) return line
  let repaired = ''
  let from = 0
  for (const position of insertAt) {
    repaired += `${line.slice(from, position)}>`
    from = position
  }
  return repaired + line.slice(from)
}

/** `markdown` with every unclosed angle-bracket file destination closed. */
export function repairMarkdownFileLinks(markdown: string): string {
  if (!markdown.includes('](<')) return markdown
  let fence: { char: string; width: number } | null = null
  return markdown
    .split('\n')
    .map((line) => {
      if (fence) {
        const closer = FENCE_CLOSER.exec(line)
        if (closer && closer[1][0] === fence.char && closer[1].length >= fence.width) fence = null
        return line
      }
      const opener = FENCE_OPENER.exec(line)
      if (opener && (opener[1][0] === '~' || !line.slice(opener[0].length).includes('`'))) {
        fence = { char: opener[1][0], width: opener[1].length }
        return line
      }
      return line.includes('](<') ? repairLine(line) : line
    })
    .join('\n')
}
