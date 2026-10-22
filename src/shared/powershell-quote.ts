// PowerShell's single-quoted strings. Its tokenizer takes any of five
// characters as a single quote: the ASCII one and the typographic U+2018 to
// U+201B. Each ends the string, and two in a row stand for the second. So a
// value is quoted by doubling every one of them, not just the ASCII one: a
// path or a session id with a curly quote in it would otherwise end the
// literal there, and whatever follows would be read as PowerShell.

const SINGLE_QUOTES = /['‘-‛]/gu

/** `value` for inside a PowerShell single-quoted string, without the quotes around it. */
export function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(SINGLE_QUOTES, '$&$&')
}

/** `value` as a PowerShell single-quoted string literal. */
export function powerShellSingleQuoted(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`
}
