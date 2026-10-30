import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'vitest'

import { REACT_READER_ATTRIBUTE, reactContextFrom, reactReaderScript, readReactContext } from './browser-guest-react'

// A DOM node as React leaves it: its fiber on an expando only the page's
// world can see, each fiber pointing up at the one that rendered it.
function reactNode() {
  function SignInButton() {}
  const form = { type: { displayName: 'SignInForm' }, return: null }
  const button = {
    type: SignInButton,
    _debugSource: { fileName: 'src/components/SignIn.tsx', lineNumber: 42, columnNumber: 7 },
    return: { type: 'button', return: form },
  }
  return { __reactFiber$abc123: { type: 'button', return: button } }
}

function pageWorld(node: object | null, seen: string[] = []) {
  return {
    document: {
      querySelector: (selector: string) => {
        seen.push(selector)
        return node
      },
    },
  }
}

test('the page-world script reads the component chain and source off the marked element', () => {
  const seen: string[] = []
  const answer = runInNewContext(reactReaderScript('tok-1'), pageWorld(reactNode(), seen))
  assert.deepEqual(seen, [`[${REACT_READER_ATTRIBUTE}="tok-1"]`])
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), {
    components: ['SignInButton', 'SignInForm'],
    source: 'src/components/SignIn.tsx:42:7',
  })
})

test('the page-world script answers empty for a page without React, or a missing element', () => {
  const plain = runInNewContext(reactReaderScript('t'), pageWorld({ id: 'root' }))
  assert.deepEqual(JSON.parse(JSON.stringify(plain)), { components: [], source: null })
  const missing = runInNewContext(reactReaderScript('t'), pageWorld(null))
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), { components: [], source: null })
})

test('a token cannot break out of the selector the script is built with', () => {
  const script = reactReaderScript('"]; alert(1); ["')
  assert.ok(script.includes(`[${REACT_READER_ATTRIBUTE}=\\"alert1\\"]`))
  assert.ok(!script.includes('alert(1)'))
})

test("the page world's answer is re-typed and capped", () => {
  assert.deepEqual(reactContextFrom(null), { components: [], source: null })
  assert.deepEqual(reactContextFrom('App'), { components: [], source: null })
  assert.deepEqual(
    reactContextFrom({ components: ['App', 7, '', 'x'.repeat(200), 'Fourth', 'Fifth'], source: { toString: 1 } }),
    { components: ['App', 'x'.repeat(80), 'Fourth'], source: null },
  )
  assert.equal(reactContextFrom({ components: [], source: 's'.repeat(900) }).source?.length, 500)
})

function markableElement() {
  const attributes = new Map<string, string>()
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  } as unknown as Element & { attributes: Map<string, string> }
}

test('the element is marked only while the page world is asked', async () => {
  const element = markableElement()
  const context = await readReactContext(
    element,
    async (code) => {
      assert.equal(element.attributes.get(REACT_READER_ATTRIBUTE), 'tok')
      assert.ok(code.includes('"tok\\"]'))
      return { components: ['Button'], source: 'src/App.tsx:1' }
    },
    'tok',
  )
  assert.deepEqual(context, { components: ['Button'], source: 'src/App.tsx:1' })
  assert.equal(element.attributes.has(REACT_READER_ATTRIBUTE), false)
})

test('a page world that throws or never answers costs the pick its components, not the pick', async () => {
  const element = markableElement()
  const thrown = await readReactContext(element, () => Promise.reject(new Error('page broke it')), 'a')
  assert.deepEqual(thrown, { components: [], source: null })
  const hung = await readReactContext(element, () => new Promise(() => {}), 'b', 10)
  assert.deepEqual(hung, { components: [], source: null })
  assert.equal(element.attributes.has(REACT_READER_ATTRIBUTE), false)
})
