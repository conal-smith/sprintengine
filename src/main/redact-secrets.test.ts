import assert from 'node:assert/strict'
import { test } from 'vitest'

import { redactSecrets } from './redact-secrets'

test('token-shaped strings are redacted wherever they sit in a line', () => {
  const line = [
    'device mctn_AbCdEf0123456789_-xyz',
    'pairing mcpair_AbCdEf0123456789',
    'gh ghp_0123456789abcdefghijABCDEFGHIJ',
    'oauth gho_0123456789abcdefghijABCDEFGHIJ',
    'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'key sk-ant-api03-0123456789abcdef',
    'slack xoxb-1234567890-abcdefghij',
    'Authorization: Bearer eyJhbGciOi.payload.sig',
    'Basic dXNlcjpwYXNzd29yZA==',
    'token=abc123 api_key: "s3cr3t" password=hunter2',
    'clone https://dev:p4ss@example.com/acme/repo.git',
  ].join(' | ')
  const out = redactSecrets(line)
  for (const secret of [
    'mctn_AbCdEf',
    'mcpair_AbCdEf',
    'ghp_0123',
    'gho_0123',
    'github_pat_11',
    'sk-ant-api03',
    'xoxb-1234567890',
    'eyJhbGciOi',
    'dXNlcjpwYXNzd29yZA',
    'abc123',
    's3cr3t',
    'hunter2',
    'p4ss',
  ]) {
    assert.equal(out.includes(secret), false, `${secret} is redacted in: ${out}`)
  }
  assert.match(out, /Authorization: Bearer \[redacted\]/u)
  assert.match(out, /token=\[redacted\]/u)
  assert.match(out, /https:\/\/\[redacted\]@example\.com\/acme\/repo\.git/u)
})

test('ordinary diagnostic text is left as it is', () => {
  for (const line of [
    'Basic authentication is not supported by this server',
    'maxTokens: 4096, inputTokens=12',
    'the token expired; signing in again',
    '/Users/dev/app/.sprintengine-worktrees/app/pool-01: recovery failed',
    'https://github.com/acme/repo/pull/12',
  ]) {
    assert.equal(redactSecrets(line), line)
  }
})
