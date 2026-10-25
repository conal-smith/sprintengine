// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'

import { ConversationApprovalSettings } from './ConversationApprovalSettings'

// Settings lists the "always allow" rules each paired machine's chats run
// with beside this computer's, and revokes one there.

test('a paired machine’s rules are listed under it, and revoked there', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const revoked: unknown[] = []
  let rules = [
    { id: 'r1', label: 'Run npm test', toolName: 'Bash', toolKind: 'command', project: 'parser', createdAt: 1 },
  ]
  ;(window as unknown as { api: unknown }).api = {
    conversationApprovalRules: async () => ({ ok: true, rules: [] }),
    meshListConnections: async () => [
      { id: 'c1', machineName: 'mac-mini' },
      { id: 'c2', machineName: 'build-box' },
    ],
    meshApprovalRules: async ({ connectionId }: { connectionId: string }) =>
      connectionId === 'c1'
        ? { ok: true, rules }
        : {
            ok: false,
            code: 'approval_rules_unsupported',
            message:
              'build-box does not share its chat permissions yet. Update SprintEngine Studio there to see them from here.',
          },
    meshRevokeApprovalRule: async (input: unknown) => {
      revoked.push(input)
      rules = []
      return { ok: true, ruleId: 'r1' }
    },
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<ConversationApprovalSettings />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(host.textContent).toContain('On mac-mini')
  expect(host.textContent).toContain('Run npm test')
  expect(host.textContent).toContain('parser')
  expect(host.textContent).toContain('build-box does not share its chat permissions yet.')
  const revoke = host.querySelector<HTMLButtonElement>('button[aria-label="Revoke Run npm test on mac-mini"]')
  await act(async () => revoke!.click())
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(revoked).toEqual([{ connectionId: 'c1', ruleId: 'r1' }])
  expect(host.textContent).toContain('No workspace permissions have been remembered there.')
  await act(async () => root.unmount())
  host.remove()
})
