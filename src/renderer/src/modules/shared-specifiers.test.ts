import assert from 'node:assert/strict'
import { test } from 'vitest'

import { bindSharedSpecifiers } from './shared-specifiers'

const URLS = { react: 'blob:file:///r-1', 'react/jsx-runtime': 'blob:file:///j-2' }

test("a bundle's imports of the shared names point at the app's instances", () => {
  const bundle = [
    'import{useState as e}from"react";',
    "import { jsx } from 'react/jsx-runtime'",
    'export { useMemo } from "react"',
    "const lazy = () => import('react')",
    "import local from './chunk.js'",
    'import other from "react-dom"',
  ].join('\n')
  assert.equal(
    bindSharedSpecifiers(bundle, URLS),
    [
      'import{useState as e}from"blob:file:///r-1";',
      "import { jsx } from 'blob:file:///j-2'",
      'export { useMemo } from "blob:file:///r-1"',
      'const lazy = () => import("blob:file:///r-1")',
      "import local from './chunk.js'",
      'import other from "react-dom"',
    ].join('\n'),
  )
})

test('text that only looks like an import is left as it was written', () => {
  const bundle = [
    'const note = "import x from \\"react\\""',
    '// import y from "react"',
    'const name = "react"',
    'const dynamic = (n) => import(n)',
  ].join('\n')
  assert.equal(bindSharedSpecifiers(bundle, URLS), bundle)
})
