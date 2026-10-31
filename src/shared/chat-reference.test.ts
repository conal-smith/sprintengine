import { expect, test } from 'vitest'
import { CHAT_REFERENCE_MIME, chatReferenceMarkdown, setChatReferenceDragData } from './chat-reference'
import { chatLinkFor } from './deep-link'

test("a chat's reference is a link named by its title to the chat's own address", () => {
  expect(chatReferenceMarkdown('Fix the login redirect', 'ws-123')).toBe(
    `[Fix the login redirect](${chatLinkFor('ws-123')})`,
  )
})

test('a title is flattened, cut, and kept from ending the link early', () => {
  expect(chatReferenceMarkdown('  Plan [v2]\n release \\ notes ', 'ws-1')).toBe(
    `[Plan \\[v2\\] release \\\\ notes](${chatLinkFor('ws-1')})`,
  )
  expect(chatReferenceMarkdown('', 'ws-1')).toBe(`[Untitled chat](${chatLinkFor('ws-1')})`)
  const long = chatReferenceMarkdown('x'.repeat(200), 'ws-1')!
  expect(long.startsWith(`[${'x'.repeat(79)}…]`)).toBe(true)
})

test('an id a link cannot carry gives no reference', () => {
  expect(chatReferenceMarkdown('Title', 'not a valid id!')).toBeNull()
})

test("a local chat's drag carries its reference as text; a paired machine's carries none", () => {
  const data = new Map<string, string>()
  const transfer = { setData: (type: string, value: string) => void data.set(type, value) }
  expect(setChatReferenceDragData(transfer, { id: 'ws-9', name: 'Release notes', remote: false })).toBe(true)
  expect(data.get('text/plain')).toBe(`[Release notes](${chatLinkFor('ws-9')})`)
  expect(data.get(CHAT_REFERENCE_MIME)).toBe('ws-9')
  data.clear()
  expect(setChatReferenceDragData(transfer, { id: 'ws-9', name: 'Release notes', remote: true })).toBe(false)
  expect(data.size).toBe(0)
})
