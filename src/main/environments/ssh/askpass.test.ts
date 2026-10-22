import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { beforeAll, test } from 'vitest'

import { classifyPrompt, createAskpassBroker, marksRemotePrompts, type AskpassRequest } from './askpass'
import { DOCKER_TESTS, prepareSshdImage, SSHD_IMAGE_BUILD_MS, startSshd } from './__fixtures__/docker-sshd'
import { buildSshArgs, parseDestination, sshEnvironment } from './ssh-command'

/** The shim run as ssh runs it. Never synchronously: the broker answers on this process's own loop. */
function runShim(program: string, env: Record<string, string>, prompt: string) {
  return new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn(program, [prompt], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.on('close', (status) => resolve({ status, stdout }))
  })
}

// Recorded from OpenSSH 10.0 against the test sshd (spec E1.2, E1.5).
const HOST_KEY = `The authenticity of host '[127.0.0.1]:32768 ([127.0.0.1]:32768)' can't be established.
ED25519 key fingerprint is SHA256:fjpaS/7fJJzetL6Tkqbs/dUSrDlQ7ZOeBJ9UImHlsGc.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])? `

test("prompts are told apart by ssh's own words; the remote's text never passes for one", () => {
  const hostKey = classifyPrompt(HOST_KEY)
  assert.equal(hostKey.kind, 'host-key')
  assert.deepEqual(hostKey.hostKey, {
    host: '[127.0.0.1]:32768 ([127.0.0.1]:32768)',
    keyType: 'ED25519',
    fingerprint: 'SHA256:fjpaS/7fJJzetL6Tkqbs/dUSrDlQ7ZOeBJ9UImHlsGc',
  })
  assert.equal(classifyPrompt("Enter passphrase for key '/Users/dev/.ssh/id_ed25519': ").kind, 'passphrase')
  // ssh truncates a long key path; the shape is enough.
  assert.equal(classifyPrompt("Enter passphrase for key '/Users/dev/.ssh/a-very-long-na…': ").kind, 'passphrase')
  assert.equal(classifyPrompt("dev@build-box's password: ").kind, 'password')
  assert.equal(
    classifyPrompt('Allow use of key /Users/dev/.ssh/id_ecdsa_sk?\nKey fingerprint SHA256:x', 'confirm').kind,
    'confirm',
  )
  assert.equal(classifyPrompt('Confirm user presence for key ED25519-SK SHA256:abc', 'none').kind, 'touch')
  // Keyboard-interactive: the remote's own words, prefixed by ssh with (user@host).
  assert.equal(classifyPrompt('(dev@build-box) Verification code: ').kind, 'remote')
  assert.equal(classifyPrompt('(dev@build-box) Passcode or option (1-3): ').kind, 'remote')
  // A remote that dresses its question up as ssh's own is still the remote's.
  assert.equal(classifyPrompt("(dev@build-box) Enter passphrase for key '/Users/dev/.ssh/id_ed25519': ").kind, 'remote')
  assert.equal(classifyPrompt(`(dev@build-box) ${HOST_KEY}`).kind, 'remote')
  assert.equal(classifyPrompt('Something nobody expected: ').kind, 'remote')
  // A host-key question with no fingerprint in it is not trusted to be one.
  assert.equal(classifyPrompt("The authenticity of host 'x' can't be established.\nAre you sure?").kind, 'remote')
})

test('the shim carries one question and one answer, and only for a token this app issued', async () => {
  const asked: AskpassRequest[] = []
  const broker = await createAskpassBroker({
    runAsNode: false,
    ask: async (request) => {
      asked.push(request)
      return request.kind === 'password' ? 'pa ss' : null
    },
  })
  try {
    const issued = broker.issue('build-box')
    const run = (env: Record<string, string>, prompt: string) => runShim(issued.env.program, env, prompt)
    const env = { SPRINTENGINE_ASKPASS_SOCKET: issued.env.socket, SPRINTENGINE_ASKPASS_TOKEN: issued.env.token }
    const answered = await run(env, "dev@build-box's password: ")
    assert.equal(answered.status, 0)
    assert.equal(answered.stdout, 'pa ss\n')
    assert.equal(asked[0]?.label, 'build-box')
    // Cancel is a non-zero exit, which ssh reads as no answer.
    assert.notEqual((await run(env, 'Verification code: ')).status, 0)
    // A token nobody issued: refused before anything is asked.
    assert.notEqual(
      (await run({ ...env, SPRINTENGINE_ASKPASS_TOKEN: 'forged' }, "dev@build-box's password: ")).status,
      0,
    )
    issued.revoke()
    assert.notEqual((await run(env, "dev@build-box's password: ")).status, 0, 'revoked with its spawn')
    assert.equal(asked.length, 2)
    // The program and the socket are this user's alone.
    assert.match(readFileSync(issued.env.program, 'utf8'), /^#!\/bin\/sh\n/u)
  } finally {
    broker.close()
  }
})

test('a question nobody answers is given up after the deadline', async () => {
  const broker = await createAskpassBroker({
    runAsNode: false,
    timeoutMs: 300,
    ask: (_request, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('too late'))),
  })
  try {
    const issued = broker.issue('build-box')
    const started = Date.now()
    const result = await runShim(
      issued.env.program,
      { SPRINTENGINE_ASKPASS_SOCKET: issued.env.socket, SPRINTENGINE_ASKPASS_TOKEN: issued.env.token },
      "dev@build-box's password: ",
    )
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '', 'an answer that came too late is not given')
    assert.ok(Date.now() - started < 5_000)
  } finally {
    broker.close()
  }
})

// The real thing: ssh asks through the shim on first connect (the host key)
// and for the key's passphrase, against a container's sshd. The image is
// built here, not in the test: a first build is minutes of apt-get.
beforeAll(async () => {
  if (DOCKER_TESTS) await prepareSshdImage()
}, SSHD_IMAGE_BUILD_MS)

/** One ssh session's deadline: a connect to a local container takes a second or two, so one past this is stuck. */
const SESSION_MS = 30_000

test.skipIf(!DOCKER_TESTS)(
  'ssh asks the host key and the passphrase through the shim, and a refusal is clean',
  async () => {
    const sshd = startSshd({ passphrase: 'correct horse' })
    const asked: AskpassRequest[] = []
    let trust = false
    const broker = await createAskpassBroker({
      runAsNode: false,
      ask: async (request) => {
        asked.push(request)
        if (request.kind === 'host-key') return trust ? 'yes' : 'no'
        if (request.kind === 'passphrase') return 'correct horse'
        return null
      },
    })
    const destination = parseDestination('build-box')
    assert.ok(destination.ok)
    const live = new Set<ChildProcess>()
    const session = () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const issued = broker.issue('build-box')
        const child = spawn(
          'ssh',
          buildSshArgs(destination.destination, { batch: false, configFile: sshd.configFile }),
          {
            env: sshEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME }, issued.env),
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
        live.add(child)
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
        // Stuck is said with what ssh had asked and printed, not as the whole test's timeout.
        const stuck = setTimeout(() => {
          child.kill('SIGKILL')
          reject(
            new Error(
              `ssh was still running after ${SESSION_MS} ms; asked so far: [${asked.map((r) => r.kind).join(', ')}]\nstderr:\n${stderr}`,
            ),
          )
        }, SESSION_MS)
        child.on('close', (code) => {
          clearTimeout(stuck)
          live.delete(child)
          issued.revoke()
          resolve({ code, stdout, stderr })
        })
        child.stdin.end('{ echo "@@SPRINTENGINE_HELLO $(uname -s)"; exit 0; }\n')
      })
    try {
      const refused = await session()
      assert.equal(refused.code, 255)
      assert.match(refused.stderr, /Host key verification failed/u)
      assert.equal(asked[0]?.kind, 'host-key')
      assert.match(asked[0]!.hostKey!.fingerprint, /^SHA256:/u)
      let knownHosts = ''
      try {
        knownHosts = readFileSync(sshd.knownHosts, 'utf8')
      } catch {
        // Not written: what a refusal should leave.
      }
      assert.equal(knownHosts, '', 'a refused key is never written')

      trust = true
      const accepted = await session()
      assert.equal(accepted.code, 0, accepted.stderr)
      assert.match(accepted.stdout, /@@SPRINTENGINE_HELLO Linux/u)
      assert.match(accepted.stdout, /Welcome to build-box/u, 'the profile noise arrives before the marker')
      assert.deepEqual(
        asked.map((request) => request.kind),
        ['host-key', 'host-key', 'passphrase'],
      )
      assert.ok(readFileSync(sshd.knownHosts, 'utf8').includes('[127.0.0.1]'), 'ssh wrote the trusted key itself')
    } finally {
      for (const child of live) child.kill('SIGKILL')
      broker.close()
      sshd.stop()
    }
  },
)

test('before OpenSSH 8.4 a passphrase or password question is one Studio cannot vouch for', () => {
  assert.equal(marksRemotePrompts('OpenSSH_10.0p2, LibreSSL 3.3.6'), true)
  assert.equal(marksRemotePrompts('OpenSSH_8.4p1 Debian-5, OpenSSL 1.1.1n'), true)
  assert.equal(marksRemotePrompts('OpenSSH_8.2p1 Ubuntu-4ubuntu0.11, OpenSSL 1.1.1f'), false)
  assert.equal(marksRemotePrompts('OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2'), false)
  assert.equal(marksRemotePrompts('OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2'), true)
  assert.equal(marksRemotePrompts(''), false, 'an ssh that does not say is not trusted to mark')
  const old = { remoteMarked: false }
  // A remote on such a client can write ssh's own words; the dialog says it cannot tell.
  const passphrase = classifyPrompt("Enter passphrase for key '/Users/dev/.ssh/id_ed25519': ", '', old)
  assert.equal(passphrase.kind, 'passphrase')
  assert.equal(passphrase.unverified, true)
  assert.equal(classifyPrompt("dev@build-box's password: ", '', old).unverified, true)
  assert.equal(classifyPrompt('Verification code: ', '', old).kind, 'remote')
  assert.equal(classifyPrompt("Enter passphrase for key '/Users/dev/.ssh/id_ed25519': ").unverified, undefined)
})
