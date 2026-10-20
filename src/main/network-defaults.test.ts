import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'vitest'

import { MIN_CONNECT_ATTEMPT_TIMEOUT_MS, raiseConnectAttemptTimeout } from './network-defaults'

function fakeNet(timeout: number) {
  const api = {
    timeout,
    getDefaultAutoSelectFamilyAttemptTimeout: () => api.timeout,
    setDefaultAutoSelectFamilyAttemptTimeout: (value: number) => {
      api.timeout = value
    },
  }
  return api
}

test('each connection attempt gets at least a second, and a longer timeout already set is kept', () => {
  const short = fakeNet(250)
  raiseConnectAttemptTimeout(short)
  assert.equal(short.timeout, MIN_CONNECT_ATTEMPT_TIMEOUT_MS)

  const long = fakeNet(5_000)
  raiseConnectAttemptTimeout(long)
  assert.equal(long.timeout, 5_000)
})

test("the process's own default is raised", () => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout()
  try {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250)
    raiseConnectAttemptTimeout()
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), MIN_CONNECT_ATTEMPT_TIMEOUT_MS)
  } finally {
    net.setDefaultAutoSelectFamilyAttemptTimeout(before)
  }
})
