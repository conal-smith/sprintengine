// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'vitest'

import { asReactContext, READ_REACT_CONTEXT_SCRIPT } from './browser-guest-react'

// The picker's preload runs in a world of its own and asks the page's world
// for the React fiber of the element picked. Here the "page's world" is the
// test's document: the script is evaluated as the source text it is sent as,
// in a context that has nothing but the document.

function readInPage(attribute: string, marker: string): unknown {
  // Copied out the way an answer crosses from one world to another.
  const answer: unknown = runInNewContext(
    `${READ_REACT_CONTEXT_SCRIPT}(${JSON.stringify(attribute)}, ${JSON.stringify(marker)})`,
    {
      document,
    },
  )
  return JSON.parse(JSON.stringify(answer))
}

test('the page-world script reads the component chain and source off the marked element', () => {
  function SignInButton() {}
  const Form = { displayName: 'SignInForm' }
  const Memo = { type: { render: { name: 'Card' } } }
  const button = document.createElement('button')
  document.body.append(button)
  ;(button as unknown as Record<string, unknown>)['__reactFiber$abc'] = {
    type: 'button',
    _debugSource: { fileName: 'src/SignIn.tsx', lineNumber: 42, columnNumber: 7 },
    return: { type: SignInButton, return: { type: Form, return: { type: Memo, return: { type: () => {} } } } },
  }
  button.setAttribute('data-sprintengine-pick', 'm1')
  assert.deepEqual(readInPage('data-sprintengine-pick', 'm1'), {
    components: ['SignInButton', 'SignInForm', 'Card'],
    source: 'src/SignIn.tsx:42:7',
  })
  // Another marker finds nothing, and a page without React has no context.
  assert.deepEqual(readInPage('data-sprintengine-pick', 'other'), { components: [], source: null })
  const plain = document.createElement('div')
  plain.setAttribute('data-sprintengine-pick', 'm2')
  document.body.append(plain)
  assert.deepEqual(readInPage('data-sprintengine-pick', 'm2'), { components: [], source: null })
  // A cycle in the fiber chain ends at the hop limit.
  const looped: Record<string, unknown> = { type: 'div' }
  looped.return = looped
  ;(plain as unknown as Record<string, unknown>)['__reactFiber$x'] = looped
  assert.deepEqual(readInPage('data-sprintengine-pick', 'm2'), { components: [], source: null })
})

test("what the page's world answers is re-typed and capped", () => {
  assert.deepEqual(asReactContext(null), { components: [], source: null })
  assert.deepEqual(asReactContext('x'), { components: [], source: null })
  assert.deepEqual(
    asReactContext({ components: ['A'.repeat(500), 7, 'B', 'C', 'D'], source: 'S'.repeat(2000), extra: 1 }),
    { components: ['A'.repeat(80), 'B', 'C'], source: 'S'.repeat(500) },
  )
  assert.deepEqual(asReactContext({ components: 'A', source: 42 }), { components: [], source: null })
})
