import assert from 'node:assert/strict'

import { DESIGN_SYSTEM_ATTACHED_PROMPT_LINE } from '../design-system/attach'
import { knowledgeLaunchContext } from '../project-knowledge'
import {
  HOST_CONTEXT_BOUNDARY_LINE,
  HOST_CONTEXT_CLOSE_TAG,
  HOST_CONTEXT_OPEN_TAG,
  CURSOR_HOST_CONTEXT_PLUGIN_NAME,
  EDITOR_TOOLS_HOST_CONTEXT_SECTION,
  buildCursorHostContextPluginManifest,
  buildCursorHostContextRuleFile,
  buildHostContextDocument,
  toTomlBasicString,
  wrapHostContextForPrompt,
} from './document'
import { test } from 'vitest'

test('document', async () => {
  // The host-context document (design door). Two invariants carry the
  // whole feature: the boundary is stated FIRST in every mode, and the wording of
  // both sections is the wording the old prompt suffixes already used — the
  // channel changed, the instructions did not.

  function run(name: string, body: () => void): void {
    body()
    console.log(`ok - ${name}`)
  }

  run('nothing to say means no document at all', () => {
    // A plain repo launches exactly as it did: no file, no flag, no wrapping.
    assert.equal(buildHostContextDocument({}), null)
    assert.equal(buildHostContextDocument({ knowledge: { ok: false } }), null)
  })

  run('the boundary line comes first, in every document', () => {
    const doc = buildHostContextDocument({ designSystem: { bundlePath: '/repo/design-system' } })
    assert.ok(doc)
    assert.equal(doc.split('\n')[0], HOST_CONTEXT_BOUNDARY_LINE)
    // It says who is speaking and that this is not the user talking — the whole
    // reason a flag-delivered document still needs a preamble.
    assert.match(HOST_CONTEXT_BOUNDARY_LINE, /SprintEngine Studio/)
    assert.match(HOST_CONTEXT_BOUNDARY_LINE, /not part of the user/)
  })

  run('a design system with no knowledge graph still emits — the KG-independent invariant', () => {
    const doc = buildHostContextDocument({ designSystem: { bundlePath: '/repo/design-system' } })
    assert.ok(doc)
    assert.ok(doc.includes(DESIGN_SYSTEM_ATTACHED_PROMPT_LINE), 'the shipped line, verbatim')
    assert.ok(doc.includes('/repo/design-system'), 'and the absolute path the flag channel can afford')
    assert.ok(!doc.includes('Knowledge Graph'), 'no knowledge section when none is configured')
  })

  run('a knowledge graph with no design system still emits', () => {
    const doc = buildHostContextDocument({
      knowledge: { ok: true, rootPath: '/repo/knowledge', relativeRoot: 'knowledge' },
    })
    assert.ok(doc)
    const shipped = knowledgeLaunchContext({ ok: true, rootPath: '/repo/knowledge', relativeRoot: 'knowledge' })
    assert.ok(shipped.promptSuffix)
    assert.ok(doc.includes(shipped.promptSuffix), 'same sentence the prompt suffix used')
    assert.ok(!doc.includes('design system is attached'), 'no design section when none is attached')
  })

  run('a configured-but-unreadable knowledge root is still said out loud', () => {
    // Saying nothing would leave the agent free to guess another knowledge folder,
    // which is exactly what the shipped line forbids.
    const doc = buildHostContextDocument({ knowledge: { ok: false, relativeRoot: 'knowledge' } })
    assert.ok(doc)
    assert.match(doc, /missing or inaccessible/)
    assert.match(doc, /Do not guess another knowledge folder/)
  })

  run('both sections appear, design system first', () => {
    const doc = buildHostContextDocument({
      designSystem: { bundlePath: '/repo/design-system' },
      knowledge: { ok: true, rootPath: '/repo/knowledge', relativeRoot: 'knowledge' },
    })
    assert.ok(doc)
    assert.ok(doc.indexOf('## Design system') < doc.indexOf('## Knowledge graph'))
  })

  run('the prompt fallback puts the block AFTER the request', () => {
    const doc = buildHostContextDocument({ designSystem: { bundlePath: '/repo/design-system' } })
    const wrapped = wrapHostContextForPrompt(doc, 'Build the settings page.')
    assert.ok(wrapped)
    assert.ok(wrapped.startsWith('Build the settings page.'), 'the request is first so the title hook sees it')
    assert.ok(wrapped.includes(HOST_CONTEXT_OPEN_TAG), 'tagged, so host words are recoverable')
    assert.ok(wrapped.includes(HOST_CONTEXT_CLOSE_TAG))
    assert.ok(
      wrapped.indexOf('Build the settings page.') < wrapped.indexOf(HOST_CONTEXT_OPEN_TAG),
      'host context sits below the request',
    )
  })

  run('with no document the prompt is returned untouched', () => {
    assert.equal(wrapHostContextForPrompt(null, 'Build it.'), 'Build it.')
    assert.equal(wrapHostContextForPrompt(null, undefined), undefined)
  })

  run('the TOML literal survives quotes, backslashes and newlines', () => {
    // codex parses `-c developer_instructions=<value>` as TOML, so the value has
    // to be a real basic string — an unescaped newline is a parse error, and an
    // unescaped quote silently truncates the document.
    const literal = toTomlBasicString('line one\nsays "hi" \\ ok')
    assert.equal(literal, '"line one\\nsays \\"hi\\" \\\\ ok"')
    assert.ok(!literal.slice(1, -1).includes('\n'), 'no raw newline inside a basic string')
  })

  run('the Cursor plugin rule is always-apply and carries the same document', () => {
    const doc = buildHostContextDocument({ designSystem: { bundlePath: '/repo/design-system' } }) as string
    const rule = buildCursorHostContextRuleFile(doc)
    assert.ok(rule.startsWith('---\n'))
    assert.match(rule, /^alwaysApply: true$/m)
    assert.ok(rule.includes(doc), 'the body is the host-context document, not a restatement of it')
    assert.ok(!rule.includes('<host-context>'), 'prompt tags belong on the prompt fallback, not the rule')
    const manifest = JSON.parse(buildCursorHostContextPluginManifest()) as { name: string }
    assert.equal(manifest.name, CURSOR_HOST_CONTEXT_PLUGIN_NAME)
  })

  console.log('host-context document tests passed')
})

test('an agent bound to a workspace is told when to open files instead of pasting paths', () => {
  const doc = buildHostContextDocument({ editorTools: true })
  assert.ok(doc)
  assert.equal(doc.split('\n')[0], HOST_CONTEXT_BOUNDARY_LINE)
  assert.ok(doc.includes('## Showing files and diffs'))
  assert.ok(doc.includes('editor_open'))
  assert.ok(doc.includes('do not retry'))
  // Short on purpose: the section is read on every turn.
  assert.ok(EDITOR_TOOLS_HOST_CONTEXT_SECTION.split('\n').length <= 4)
  // A launch without the tools says nothing new.
  assert.equal(buildHostContextDocument({ editorTools: false }), null)
})
