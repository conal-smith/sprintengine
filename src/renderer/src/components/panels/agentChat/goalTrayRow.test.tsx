import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GoalTrayRow } from './goalTrayRow'

test('a goal the agent is working toward is named under the working mark, with its state in a word', () => {
  const html = renderToStaticMarkup(
    <GoalTrayRow goal={{ objective: 'make the parser tests pass', status: 'active' }} seed="conv_1" />,
  )
  expect(html).toContain('make the parser tests pass')
  expect(html).toContain('>Working<')
  expect(html).toContain('aria-label="Working toward the goal"')
  expect(html).toContain('aria-label="Goal, working: make the parser tests pass"')
})

test('a paused goal wears the paused glyph and says so, with nothing to dismiss', () => {
  const html = renderToStaticMarkup(
    <GoalTrayRow goal={{ objective: 'make the parser tests pass', status: 'paused' }} seed="conv_1" />,
  )
  expect(html).toContain('>Paused<')
  expect(html).not.toContain('Working toward the goal')
  expect(html).not.toContain('Dismiss')
})

test('a met goal says so and can be put away', () => {
  const html = renderToStaticMarkup(
    <GoalTrayRow goal={{ objective: 'make the parser tests pass', status: 'complete' }} seed="conv_1" />,
  )
  expect(html).toContain('>Met<')
  expect(html).toContain('aria-label="Dismiss"')
})

test('no goal draws nothing', () => {
  expect(renderToStaticMarkup(<GoalTrayRow goal={null} seed="conv_1" />)).toBe('')
})
