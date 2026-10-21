import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'vitest'

import {
  ignoreMacosTypeOfServiceEinval,
  MIN_CONNECT_ATTEMPT_TIMEOUT_MS,
  raiseConnectAttemptTimeout,
} from './network-defaults'

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

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`setTypeOfService ${code}`), { code, syscall: 'setTypeOfService' })
}

function throwingPrototype(initial: unknown) {
  const box = { error: initial, calls: [] as number[] }
  const prototype = {
    setTypeOfService(this: net.Socket, typeOfService: number): net.Socket {
      box.calls.push(typeOfService)
      if (box.error !== undefined) throw box.error
      return this
    },
  }
  return { box, prototype }
}

test('on macOS an EINVAL from setTypeOfService is ignored and the socket returned', () => {
  const { prototype } = throwingPrototype(errnoError('EINVAL'))
  ignoreMacosTypeOfServiceEinval('darwin', prototype)
  const socket = new net.Socket()
  assert.equal(prototype.setTypeOfService.call(socket, 0), socket)
})

test('on macOS any other failure from setTypeOfService still throws', () => {
  const { box, prototype } = throwingPrototype(errnoError('EPERM'))
  ignoreMacosTypeOfServiceEinval('darwin', prototype)
  const socket = new net.Socket()
  assert.throws(() => prototype.setTypeOfService.call(socket, 0), /EPERM/)

  box.error = { code: 'EINVAL' }
  assert.throws(() => prototype.setTypeOfService.call(socket, 0))
})

test('on macOS a call that succeeds passes its argument through', () => {
  const { box, prototype } = throwingPrototype(undefined)
  ignoreMacosTypeOfServiceEinval('darwin', prototype)
  const socket = new net.Socket()
  assert.equal(prototype.setTypeOfService.call(socket, 0x10), socket)
  assert.deepEqual(box.calls, [0x10])
})

test('off macOS, or without setTypeOfService, nothing is changed', () => {
  const { prototype } = throwingPrototype(errnoError('EINVAL'))
  const original = prototype.setTypeOfService
  ignoreMacosTypeOfServiceEinval('linux', prototype)
  ignoreMacosTypeOfServiceEinval('win32', prototype)
  assert.equal(prototype.setTypeOfService, original)

  const without: Parameters<typeof ignoreMacosTypeOfServiceEinval>[1] = {}
  ignoreMacosTypeOfServiceEinval('darwin', without)
  assert.equal('setTypeOfService' in without, false)
})
