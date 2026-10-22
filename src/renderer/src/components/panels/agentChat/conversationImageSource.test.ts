import { expect, test } from 'vitest'

import { resolveTerminalFileReferencePath } from '../../../utils/terminalFileLinks'
import { conversationImageSource } from './ConversationImage'

test('a reply image on another machine is not read', () => {
  for (const src of [
    '\\\\files.example.test\\share\\cat.png',
    '//files.example.test/share/cat.png',
    'file://files.example.test/share/cat.png',
    'file:////files.example.test/share/cat.png',
  ]) {
    expect(conversationImageSource(src)).toBeNull()
  }
  expect(conversationImageSource('/Users/dev/shot.png')).toEqual({ kind: 'path', path: '/Users/dev/shot.png' })
  expect(conversationImageSource('file:///Users/dev/shot.png')).toEqual({ kind: 'path', path: '/Users/dev/shot.png' })
})

test('a file reference on another machine resolves to nothing', () => {
  const roots = { workspaceRoot: '/Users/dev/app' }
  expect(resolveTerminalFileReferencePath('\\\\files.example.test\\share\\cat.png', roots)).toBeNull()
  expect(resolveTerminalFileReferencePath('//files.example.test/share/cat.png', roots)).toBeNull()
  expect(resolveTerminalFileReferencePath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.png', roots)).toBe(
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.png',
  )
  expect(resolveTerminalFileReferencePath('src/a.png', roots)).toBe('/Users/dev/app/src/a.png')
})
