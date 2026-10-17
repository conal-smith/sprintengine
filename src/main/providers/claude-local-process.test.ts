import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { spawnClaudeLocalProcess } from './claude-local-process'

let scratch: string | null = null
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = null
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test.skipIf(process.platform === 'win32')(
  'what an MCP server the CLI started leaves behind ends with the CLI, whatever ended it',
  async () => {
    scratch = await mkdtemp(join(tmpdir(), 'claude-local-process-'))
    const pidFile = join(scratch, 'grandchild.pid')
    // A stand-in CLI whose MCP server wrapper started a server of its own,
    // which the CLI's own shutdown would not reach.
    const cli = spawnClaudeLocalProcess('/bin/sh', ['-c', `sleep 300 & echo $! > '${pidFile}'; exec sleep 300`], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    await until(async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim() !== '')
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim())
    expect(alive(grandchild)).toBe(true)

    const exited = new Promise((resolve) => cli.once('exit', resolve))
    cli.kill('SIGTERM')
    await exited
    await until(() => !alive(grandchild))
  },
)
