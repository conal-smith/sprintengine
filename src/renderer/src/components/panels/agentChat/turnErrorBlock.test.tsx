import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { TranscriptEntry } from './conversationProjection'
import { isAuthShapedFailure, permissionDeniedReason, TurnErrorBlock, type TimelineChrome } from './timelineRows'

type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>

// The failure Claude Code reports when its login lapsed and could not refresh.
const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed'
// What it reports for a 403, filed under the same authentication failure.
const REFUSED = 'Failed to authenticate. API Error: 403 Your organization does not have access to this model.'

const failedTurn = (failureDetail: string): AssistantEntry =>
  ({
    kind: 'assistant',
    id: 'a1',
    turnId: 'turn-1',
    text: '',
    reasoning: '',
    tools: [],
    status: 'failed',
    failureReason: 'provider',
    failureDetail,
  }) as unknown as AssistantEntry

const chrome = (extra: Partial<TimelineChrome> = {}): TimelineChrome => ({
  assistantName: 'Claude Code',
  retryTurnId: 'turn-1',
  onRetry: () => undefined,
  retryDisabled: false,
  ...extra,
})

const render = (entry: AssistantEntry, timelineChrome: TimelineChrome) =>
  renderToStaticMarkup(<TurnErrorBlock entry={entry} chrome={timelineChrome} />)

test('a lapsed login offers Sign in beside Retry when this machine can run it', () => {
  const html = render(failedTurn(EXPIRED), chrome({ onSignIn: async () => undefined, platform: 'darwin' }))
  expect(html).toContain('Sign in</button>')
  expect(html).toContain('Retry</button>')
  expect(html).toContain('Sign in, then retry.')
  expect(html).not.toContain('WSL')
})

test('on Windows the copy says it is the Windows sign-in, not the one inside WSL', () => {
  const html = render(failedTurn(EXPIRED), chrome({ onSignIn: async () => undefined, platform: 'win32' }))
  expect(html).toContain('Claude Code for Windows')
  expect(html).toContain('WSL')
})

test('where Studio cannot sign in, the copy names the chat CLI’s own command, set as code', () => {
  const claude = render(failedTurn(EXPIRED), chrome({ cli: 'claude-code' }))
  expect(claude).not.toContain('Sign in</button>')
  expect(claude).toMatch(/<code[^>]*>claude auth login<\/code>/)
  expect(claude).not.toContain('`')

  const codex = render(failedTurn(EXPIRED), chrome({ assistantName: 'Codex', cli: 'codex' }))
  expect(codex).toMatch(/<code[^>]*>codex login<\/code>/)
  expect(codex).not.toContain('claude')
})

test('a chat whose CLI has no known sign-in command is told to sign in, not handed another CLI’s', () => {
  const html = render(failedTurn(EXPIRED), chrome({ assistantName: 'Acme Agent' }))
  expect(html).toContain('Sign in to Acme Agent in a terminal, then retry.')
  expect(html).not.toContain('<code')
  expect(html).not.toContain('claude')
})

test('a failure that is not about signing in offers no sign-in', () => {
  const html = render(failedTurn('network timeout'), chrome({ onSignIn: async () => undefined }))
  expect(html).not.toContain('Sign in')
  expect(html).toContain('Something went wrong while responding.')
})

test('the auth matcher reads real login failures and not words that merely contain "auth"', () => {
  expect(isAuthShapedFailure(EXPIRED)).toBe(true)
  expect(isAuthShapedFailure('HTTP 401 Unauthorized')).toBe(true)
  expect(isAuthShapedFailure('Invalid API key · Please run /login')).toBe(true)
  expect(isAuthShapedFailure('Could not read src/authors.ts')).toBe(false)
  expect(isAuthShapedFailure('author')).toBe(false)
  expect(isAuthShapedFailure('Request 14010 timed out')).toBe(false)
})

test('a refusal of access says the provider’s reason and offers Retry, not Sign in', () => {
  const html = render(failedTurn(REFUSED), chrome({ onSignIn: async () => undefined, cli: 'claude-code' }))
  expect(html).not.toContain('Sign in')
  expect(html).not.toContain('claude auth login')
  expect(html).not.toContain('sign-in expired')
  expect(html).toContain('Claude Code was refused access: Your organization does not have access to this model.')
  expect(html).toContain('Retry</button>')
  expect(html).toContain('Show details')

  const json = render(
    failedTurn('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Request not allowed"}}'),
    chrome({ onSignIn: async () => undefined }),
  )
  expect(json).toContain('Claude Code was refused access: Request not allowed.')
  expect(json).not.toContain('Sign in</button>')
})

test('a 401 and a lapsed login stay sign-in failures; a 403 needs the API error or refusal wording', () => {
  const unauthorized = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'
  expect(isAuthShapedFailure(unauthorized)).toBe(true)
  expect(permissionDeniedReason(unauthorized)).toBeUndefined()
  expect(render(failedTurn(unauthorized), chrome({ onSignIn: async () => undefined }))).toContain('Sign in</button>')
  expect(isAuthShapedFailure(EXPIRED)).toBe(true)
  expect(permissionDeniedReason(EXPIRED)).toBeUndefined()

  expect(isAuthShapedFailure(REFUSED)).toBe(false)
  expect(permissionDeniedReason('HTTP 403 Forbidden: permission denied for project acme')).toBe(
    'permission denied for project acme',
  )
  expect(permissionDeniedReason('API Error: 403')).toBe('')
  expect(permissionDeniedReason('Request 403 timed out')).toBeUndefined()
})

// What a Codex start refused its folder by macOS reads as, hint and all.
const PRIVACY =
  'Codex process exited (1): Error: EPERM: operation not permitted, uv_cwd. macOS may be blocking access to this folder. Allow it in System Settings › Privacy & Security › Files and Folders.'

test('a start macOS kept out of its folder leads with where to allow it, and offers the setting', () => {
  const html = render(failedTurn(PRIVACY), chrome({ onOpenPrivacySettings: () => undefined, platform: 'darwin' }))
  expect(html).toContain('macOS may be blocking access to this folder.')
  expect(html).toContain('Open Privacy settings</button>')
  expect(html).toContain('Retry</button>')
  expect(html).not.toContain('Something went wrong while responding.')
})

test('where the setting is not this Mac’s to open, the hint stands without the button', () => {
  const html = render(failedTurn(PRIVACY), chrome())
  expect(html).toContain('macOS may be blocking access to this folder.')
  expect(html).not.toContain('Open Privacy settings')
})

test('a privacy refusal is not mistaken for a lapsed login', () => {
  const html = render(failedTurn(`${PRIVACY} Please run /login`), chrome({ onSignIn: async () => undefined }))
  expect(html).not.toContain('Sign in</button>')
})

test('any other failure offers no Privacy settings', () => {
  const html = render(failedTurn('network timeout'), chrome({ onOpenPrivacySettings: () => undefined }))
  expect(html).not.toContain('Open Privacy settings')
})
