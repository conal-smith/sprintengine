import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ArtifactsSetupQuestionView } from '../../shared/artifacts'
import {
  ARTIFACTS_SETUP_QUESTION_CHANNEL,
  ARTIFACTS_SETUP_QUESTION_CLOSED_CHANNEL,
  createArtifactsSetupConsentBroker,
} from './artifacts-setup-consent-broker'
import { artifactsSetupQuestion } from './artifacts-setup-consent'

const QUESTION = artifactsSetupQuestion({ provider: 'github-pages', repositoryUrl: 'acme/artifacts' }, 'Claude Code')

function broker(options: { hasWindow?: boolean; timeoutMs?: number; fallback?: boolean } = {}) {
  const sent: Array<[string, unknown]> = []
  let fallbackAsked = 0
  const made = createArtifactsSetupConsentBroker({
    broadcast: (channel, payload) => sent.push([channel, payload]),
    hasWindow: () => options.hasWindow ?? true,
    fallback: async () => {
      fallbackAsked += 1
      return options.fallback ?? false
    },
    timeoutMs: options.timeoutMs ?? 60_000,
  })
  const asked = () =>
    sent.find(([channel]) => channel === ARTIFACTS_SETUP_QUESTION_CHANNEL)?.[1] as ArtifactsSetupQuestionView
  const closed = () => sent.filter(([channel]) => channel === ARTIFACTS_SETUP_QUESTION_CLOSED_CHANNEL).length
  return { made, sent, asked, closed, fallbackAsked: () => fallbackAsked }
}

test('the question goes to the windows, and only a yes from a workspace window confirms it', async () => {
  const { made, asked, closed } = broker()
  const answer = made.ask(QUESTION, new AbortController().signal)
  const view = asked()
  assert.equal(view.message, 'Publish artifacts with GitHub Pages?')
  assert.match(view.detail, /^Claude Code asks to set this up\./)
  assert.equal(view.confirmLabel, 'Set up GitHub Pages')
  made.answer(view.id, true, false)
  made.answer('another-id', true, true)
  made.answer(view.id, true, true)
  assert.equal(await answer, true)
  assert.equal(closed(), 1, 'every window is told it is closed')
  made.answer(view.id, false, true)
  assert.equal(closed(), 1, 'a second answer does nothing')
})

test('a page that is not a workspace window can neither say yes nor close the question', async () => {
  const { made, asked } = broker({ timeoutMs: 30 })
  const answer = made.ask(QUESTION, new AbortController().signal)
  made.answer(asked().id, true, false)
  made.answer(asked().id, false, false)
  assert.equal(await answer, false, 'it ran out, unanswered')
})

test('no, a dismissal, no answer in time, and a cancelled call are all no', async () => {
  const refused = broker()
  const no = refused.made.ask(QUESTION, new AbortController().signal)
  refused.made.answer(refused.asked().id, false, true)
  assert.equal(await no, false)

  const notAnswered = broker({ timeoutMs: 20 })
  assert.equal(await notAnswered.made.ask(QUESTION, new AbortController().signal), false)
  assert.equal(notAnswered.closed(), 1)

  const cancelled = broker()
  const controller = new AbortController()
  const pending = cancelled.made.ask(QUESTION, controller.signal)
  controller.abort()
  assert.equal(await pending, false)
  assert.equal(cancelled.closed(), 1)

  const nonBoolean = broker()
  const odd = nonBoolean.made.ask(QUESTION, new AbortController().signal)
  nonBoolean.made.answer(nonBoolean.asked().id, 'yes', true)
  assert.equal(await odd, false)
})

test('with no window showing, the native question asks instead', async () => {
  const { made, sent, fallbackAsked } = broker({ hasWindow: false, fallback: true })
  assert.equal(await made.ask(QUESTION, new AbortController().signal), true)
  assert.equal(fallbackAsked(), 1)
  assert.equal(sent.length, 0)
})

test('the question names the repository it parsed, and never carries a token', () => {
  const cloudflare = artifactsSetupQuestion(
    { provider: 'cloudflare-pages', accountName: 'Acme', projectName: '', sourceRepositoryUrl: null },
    null,
  )
  assert.equal(cloudflare.message, 'Publish artifacts with Cloudflare Pages?')
  assert.match(cloudflare.detail, /^An agent asks to set this up\./)
  assert.match(cloudflare.detail, /Account: Acme\nProject: studio-artifacts \(made if there is none\)/)
  const github = artifactsSetupQuestion(
    { provider: 'github-pages', repositoryUrl: 'git@git.acme.example:design/site.git' },
    null,
  )
  assert.match(github.detail, /Repository: design\/site on git\.acme\.example/)
})
