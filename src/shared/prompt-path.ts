/**
 * A path as prompt text, quoted only when it needs it — the terminal drop idiom.
 * A Windows path takes double quotes, which no Windows path can contain; any
 * other takes single quotes, with an apostrophe in it spliced out as `'"'"'`
 * the way a POSIX shell spells one, so `John's Files` does not end the quote.
 */
export function quotePromptPath(path: string): string {
  if (!/[\s'"]/.test(path)) return path
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) return `"${path}"`
  return `'${path.replace(/'/g, `'"'"'`)}'`
}
