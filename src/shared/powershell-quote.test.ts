import assert from 'node:assert/strict'
import { test } from 'vitest'

import { escapePowerShellSingleQuoted, powerShellSingleQuoted } from './powershell-quote'

test('every character PowerShell reads as a single quote is doubled, so none can end the literal', () => {
  assert.equal(powerShellSingleQuoted("it's"), "'it''s'")
  assert.equal(powerShellSingleQuoted('C:\\Users\\dev\\o\u2019brien'), "'C:\\Users\\dev\\o\u2019\u2019brien'")
  assert.equal(
    escapePowerShellSingleQuoted("a\u2018b\u2019c\u201Ad\u201Be'f"),
    "a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be''f",
  )
  // Double quotes and backticks mean nothing inside single quotes.
  assert.equal(powerShellSingleQuoted('say "hi" `n $env:PATH'), '\'say "hi" `n $env:PATH\'')
})

test('a quoted value reads back as itself: every quote inside comes in pairs', () => {
  const value = "x'\u2018\u2019\u201A\u201By; Remove-Item -Recurse C:\\"
  const literal = powerShellSingleQuoted(value)
  // PowerShell's rule: inside the literal, a quote followed by a quote is one
  // literal quote (the second); a lone quote ends it.
  let out = ''
  let index = 1
  for (; index < literal.length; index += 1) {
    const char = literal[index]
    if (/['\u2018-\u201B]/u.test(char)) {
      if (!/['\u2018-\u201B]/u.test(literal[index + 1] ?? '')) break
      index += 1
      out += literal[index]
    } else out += char
  }
  assert.equal(index, literal.length - 1, 'the literal ends at its closing quote')
  assert.equal(out, value)
})
