import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { ConversationLinkProvider } from './conversationLinks'
import type { TranscriptToolEntry } from './conversationProjection'
import { SubagentIcon } from './subagentIcon'
import { LaneGlyph } from './subagentStatus'
import { isSubagentStart, SubagentStartRow, subagentStartWords } from './subagentStartRow'

const start = (overrides: Partial<TranscriptToolEntry> = {}) =>
  ({
    kind: 'tool',
    id: 'tool-1',
    name: 'mcp__sprintengine-studio__subagent_start',
    status: 'completed',
    input: { cli: 'cursor', cliModel: 'muse-wonder-1.0[context=300k,reasoning_effort=high]', readOnly: true },
    ...overrides,
  }) as TranscriptToolEntry

test('a sub-agent wears its harness, whichever model that harness drives', () => {
  const claudeMark = 'viewBox="0 0 248 248"'
  expect(renderToStaticMarkup(<SubagentIcon cli="claude-code" />)).toContain(claudeMark)
  expect(renderToStaticMarkup(<SubagentIcon cli="cursor" />)).not.toContain(claudeMark)
  expect(renderToStaticMarkup(<SubagentIcon cli={null} />)).toBe('')
})

test('a lane of a chat on a paired machine, which has no record here, wears the chat’s harness', () => {
  const lane = (providerId?: string) =>
    renderToStaticMarkup(
      <ConversationLinkProvider
        workspaceId="w-followed"
        agentId="agent-there"
        cwd=""
        workspaceRoot=""
        {...(providerId === undefined ? {} : { providerId })}
      >
        <LaneGlyph tool={start()} />
      </ConversationLinkProvider>,
    )
  expect(lane('claude-agent')).toContain('viewBox="0 0 248 248"')
  // Until its machine lists it, the CLI is not known, and the kind glyph stands in.
  expect(lane('')).toContain('data-tool-glyph="subagent"')
  expect(lane()).toContain('data-tool-glyph="subagent"')
})

test('the start of a sub-agent reads as who was started, however the CLI spells the tool', () => {
  expect(isSubagentStart(start())).toBe(true)
  expect(isSubagentStart({ name: 'sprintengine-studio.subagent.start' })).toBe(true)
  expect(isSubagentStart({ name: 'mcp__other__subagent_start' })).toBe(false)
  expect(subagentStartWords(start())).toBe('Started a sub-agent · Cursor · muse-wonder-1.0 · Read-only')
  expect(subagentStartWords(start({ input: {} }))).toBe('Started a sub-agent')
})

test('a finished wait offers the reply, collapsed; a cut answer leaves it to the Agents tab', () => {
  const answered = start({ output: JSON.stringify({ subagentId: 'agent-1', result: 'Verdict: 68/100.' }) })
  const html = renderToStaticMarkup(<SubagentStartRow tool={answered} />)
  expect(html).toContain('Open in Agents')
  expect(html).toContain('Show its reply')
  expect(html).not.toContain('Verdict: 68/100.')
  const cut = start({ output: '{"ok":true,"subagentId":"agent-1","result":"A very long' })
  expect(renderToStaticMarkup(<SubagentStartRow tool={cut} />)).not.toContain('Show its reply')
})
