import assert from 'node:assert/strict'
import { test } from 'vitest'

import { decodeWslOutput } from './hosts/wsl-distro'
import { runSpawnDescriptor } from './process-run'

// `wsl.exe` prints its own errors as UTF-16LE. A process standing in for it
// writes such a message to stderr; decoded as UTF-8 it arrives with a NUL
// between every letter, which no reader of the message can match.
const WSL_ERROR = 'There is no distribution with the supplied name.\r\nError code: Wsl/WSL_E_DISTRO_NOT_FOUND\r\n'
const standIn = {
  file: process.execPath,
  args: ['-e', `process.stderr.write(Buffer.from(${JSON.stringify(WSL_ERROR)}, 'utf16le')); process.exit(1)`],
}

test("stderr is decoded as the caller says, so wsl.exe's own UTF-16 errors read as words", async () => {
  const plain = await runSpawnDescriptor(standIn)
  assert.ok(plain.stderr.includes('\0'), 'undecoded, the letters are NUL-separated')
  const decoded = await runSpawnDescriptor(standIn, { decodeStderr: decodeWslOutput })
  assert.equal(decoded.code, 1)
  assert.equal(decoded.stderr, WSL_ERROR)
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(process.platform === 'win32')(
  'a detached process that misses its deadline is ended with everything it started',
  async () => {
    // Stands in for an interactive shell whose rc file started something that
    // never exits (a version manager's daemon, a prompt helper): the child
    // starts a grandchild in its own process group, reports its pid, and hangs.
    const script = [
      "const { spawn } = require('node:child_process')",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write('grandchild:' + grandchild.pid + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join('; ')
    let grandchildPid: number | null = null
    try {
      const outcome = await runSpawnDescriptor(
        { file: process.execPath, args: ['-e', script] },
        {
          timeoutMs: 4_000,
          detached: true,
          onData: (chunk) => {
            const match = /grandchild:(\d+)/.exec(chunk)
            if (match) grandchildPid = Number(match[1])
          },
        },
      )
      assert.equal(outcome.timedOut, true)
      const pid = grandchildPid as number | null
      assert.ok(pid !== null, 'the child reported its grandchild before the deadline')
      // Killed, the grandchild is reparented and reaped; give that a moment.
      const deadline = Date.now() + 5_000
      while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(isAlive(pid), false, 'the grandchild went with the group')
    } finally {
      if (grandchildPid !== null && isAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL')
    }
  },
  20_000,
)

test('stderr split across chunks mid-character is still decoded whole', async () => {
  // Built inside the child: as one argv string it would pass Linux's 128 KiB
  // per-argument cap (MAX_ARG_STRLEN) and fail to spawn with E2BIG.
  const text = 'ü'.repeat(70_000)
  const outcome = await runSpawnDescriptor({
    file: process.execPath,
    args: ['-e', "process.stderr.write('ü'.repeat(70000))"],
  })
  assert.equal(outcome.stderr, text)
})
