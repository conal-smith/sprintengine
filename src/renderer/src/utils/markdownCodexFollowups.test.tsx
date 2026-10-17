import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from './markdown'
import { showCodexFollowupLabels } from './markdownCodexFollowups'

const LABELED: Array<[string, string, string]> = [
  [
    'a list item',
    '- :codex-followup[Prepare print version]{prompt="Make a print-ready version of the report"}',
    '- Prepare print version',
  ],
  [
    'inside a sentence',
    'Next, :codex-followup[Add tests]{prompt="Write the tests"} if you like.',
    'Next, Add tests if you like.',
  ],
  ['each one on a line', ':codex-followup[One]{prompt="first"} or :codex-followup[Two]{prompt="second"}', 'One or Two'],
  [
    'escaped quotes inside the prompt',
    '- :codex-followup[Quote it]{prompt="Say \\"hello\\" to the \\\\ team"}',
    '- Quote it',
  ],
  ['an escaped bracket in the label', ':codex-followup[Open \\[draft\\]]{prompt="open it"}', 'Open \\[draft\\]'],
  ['spaces inside the braces', ':codex-followup[Ship]{ prompt="ship it" }', 'Ship'],
  [
    'a code span elsewhere on the line',
    '`npm test`, then :codex-followup[Ship]{prompt="ship it"}',
    '`npm test`, then Ship',
  ],
  ['a line after a closed fence', '```\ncode\n```\n:codex-followup[Ship]{prompt="ship it"}', '```\ncode\n```\nShip'],
]

for (const [name, input, expected] of LABELED) {
  test(`a follow-up reads as its label: ${name}`, () => {
    expect(showCodexFollowupLabels(input)).toBe(expected)
  })
}

const UNTOUCHED: Array<[string, string]> = [
  ['a code span', 'write `:codex-followup[Ship]{prompt="ship it"}` to suggest one'],
  ['a code span of two backticks', 'write ``:codex-followup[Ship]{prompt="ship it"}`` to suggest one'],
  ['a fenced block', '```md\n:codex-followup[Ship]{prompt="ship it"}\n```'],
  ['a tilde fence', '~~~\n:codex-followup[Ship]{prompt="ship it"}\n~~~'],
  ['an empty label', ':codex-followup[]{prompt="ship it"}'],
  ['a blank label', ':codex-followup[  ]{prompt="ship it"}'],
  ['an empty prompt', ':codex-followup[Ship]{prompt=""}'],
  ['another name', ':codex-followup-extra[Ship]{prompt="ship it"}'],
  ['an escaped colon', '\\:codex-followup[Ship]{prompt="ship it"}'],
  ['a prompt still streaming', ':codex-followup[Ship]{prompt="ship i'],
  ['braces still streaming', ':codex-followup[Ship]{prompt="ship it"'],
  ['a label still streaming', ':codex-followup[Shi'],
  ['an attribute other than the prompt', ':codex-followup[Ship]{title="ship it"}'],
  ['a prompt that runs onto the next line', ':codex-followup[Ship]{prompt="ship\nit"}'],
  ['no directive at all', 'a plain reply'],
]

for (const [name, input] of UNTOUCHED) {
  test(`leaves the text as written: ${name}`, () => {
    expect(showCodexFollowupLabels(input)).toBe(input)
  })
}

test('an agent reply shows the label alone; a document renders the directive as written', () => {
  const text = 'Next steps:\n\n- :codex-followup[Prepare print version]{prompt="Make a print-ready version"}'
  const reply = renderToStaticMarkup(<>{renderMarkdown(text, { repairFileLinks: true })}</>)
  expect(reply).toContain('>Prepare print version</li>')
  expect(reply).not.toContain('codex-followup')
  expect(reply).not.toContain('print-ready')

  const document = renderToStaticMarkup(<>{renderMarkdown(text)}</>)
  expect(document).toContain(':codex-followup[Prepare print version]')
})
