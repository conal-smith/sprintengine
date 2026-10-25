import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BackgroundTasksTrayRow } from './backgroundTasksRow'
import { setConversationDisclosures } from './conversationViewState'

test('a monitor reads as work the agent is waiting on, under the working mark', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasksTrayRow tasks={[{ taskId: 'm', kind: 'monitor', description: 'CI checks' }]} seed="conv_1" />,
  )
  expect(html).toContain('Waiting on monitor: CI checks')
  expect(html).toContain('aria-label="Waiting on background work"')
  expect(html).not.toContain('data-tool-glyph')
})

test('a dev server left running is named quietly, with the shell mark', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasksTrayRow tasks={[{ taskId: 'c', kind: 'command', description: 'npm run dev' }]} seed="conv_1" />,
  )
  expect(html).toContain('Running: npm run dev')
  expect(html).toContain('data-tool-glyph="command"')
  expect(html).not.toContain('Waiting on')
})

test('several are counted, then named', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasksTrayRow
      tasks={[
        { taskId: 'm', kind: 'monitor', description: 'CI checks' },
        { taskId: 'c', kind: 'command', description: 'npm run dev' },
      ]}
      seed="conv_1"
    />,
  )
  expect(html).toContain('Waiting on 1 monitor and 1 command')
  expect(html).toContain('CI checks, npm run dev')
})

test('the row keeps to one line until it is opened, then lists one task a line', () => {
  const tasks = [
    { taskId: 'a', kind: 'command' as const, description: 'sleep 20; until gh pr checks 209; do sleep 45; done' },
    { taskId: 'b', kind: 'command' as const, description: 'npm run dev' },
  ]
  const closed = renderToStaticMarkup(<BackgroundTasksTrayRow tasks={tasks} seed="conv_1" />)
  expect(closed).toContain('aria-expanded="false"')
  expect(closed).toContain('truncate')
  expect(closed).not.toContain('<li')

  setConversationDisclosures(':', ['background-tasks'], true)
  try {
    const opened = renderToStaticMarkup(<BackgroundTasksTrayRow tasks={tasks} seed="conv_1" />)
    expect(opened).toContain('aria-expanded="true"')
    expect(opened).not.toContain('truncate')
    expect(opened).not.toContain('npm run dev</span>')
    expect(opened.match(/<li/g)).toHaveLength(2)
    expect(opened).toContain('>npm run dev</li>')
  } finally {
    setConversationDisclosures(':', ['background-tasks'], false)
  }
})

test('nothing running draws nothing', () => {
  expect(renderToStaticMarkup(<BackgroundTasksTrayRow tasks={[]} seed="conv_1" />)).toBe('')
})

test('Stop is offered where the chat can be operated, and says when it has been asked', () => {
  const tasks = [{ taskId: 'm', kind: 'monitor' as const, description: 'CI checks' }]
  expect(renderToStaticMarkup(<BackgroundTasksTrayRow tasks={tasks} seed="conv_1" />)).not.toContain('Stop')
  expect(
    renderToStaticMarkup(<BackgroundTasksTrayRow tasks={tasks} seed="conv_1" onStop={() => undefined} />),
  ).toContain('>Stop<')
  const stopping = renderToStaticMarkup(
    <BackgroundTasksTrayRow tasks={tasks} seed="conv_1" onStop={() => undefined} stopping />,
  )
  expect(stopping).toContain('Stopping…')
  expect(stopping).toContain('disabled')
})
