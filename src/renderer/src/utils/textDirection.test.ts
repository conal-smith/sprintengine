import { expect, test } from 'vitest'
import { textDirection } from './textDirection'

test.each([
  ['Arabic', 'اكتب دالة تجمع الأرقام', 'rtl'],
  ['Hebrew', 'תקן את הבאג', 'rtl'],
  ['English', 'fix the failing test', 'ltr'],
  ['Arabic that opens on an English term', 'StrictMode: يعيد الـ render مرتين في التطوير', 'rtl'],
  ['Hebrew around English names', 'ה-API של OpenAI מחזיר JSON objects', 'rtl'],
  ['English quoting one Arabic word', 'translate the label مرحبا for the login screen', 'ltr'],
  ['a tie, by its first word', 'React مكتبة', 'ltr'],
  ['a tie that opens in Arabic', 'مكتبة React', 'rtl'],
  ['Arabic around numbers and punctuation', 'عدّل السطر 42، ثم شغّل الاختبارات (3)', 'rtl'],
])('reads %s', (_, text, direction) => {
  expect(textDirection(text)).toBe(direction)
})

test('text without letters is left to what surrounds it', () => {
  expect(textDirection('42 — 7 ✓')).toBeUndefined()
  expect(textDirection('')).toBeUndefined()
})
