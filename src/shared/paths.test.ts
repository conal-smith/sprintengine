import assert from 'node:assert/strict'
import { test } from 'vitest'
import { clipboardPath } from './paths'

test('clipboardPath gives a drive path with forward slashes its backslashes', () => {
  assert.equal(clipboardPath('C:/Users/dev/repo/src/a.ts'), 'C:\\Users\\dev\\repo\\src\\a.ts')
})

test('clipboardPath evens out a drive path with mixed separators', () => {
  assert.equal(clipboardPath('d:\\repo/src\\a.ts'), 'd:\\repo\\src\\a.ts')
})

test('clipboardPath leaves a drive path already in backslashes as it is', () => {
  assert.equal(clipboardPath('C:\\repo\\a.ts'), 'C:\\repo\\a.ts')
})

test('clipboardPath gives a UNC path its backslashes', () => {
  assert.equal(clipboardPath('\\\\wsl.localhost\\Ubuntu/home/dev/a.ts'), '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts')
})

test('clipboardPath leaves a posix path untouched', () => {
  assert.equal(clipboardPath('/Users/dev/repo/src/a.ts'), '/Users/dev/repo/src/a.ts')
})

test('clipboardPath leaves a relative path untouched', () => {
  assert.equal(clipboardPath('src/a.ts'), 'src/a.ts')
})
