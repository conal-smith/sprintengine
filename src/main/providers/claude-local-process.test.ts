import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, expect, test } from 'vitest'

import { spawnClaudeLocalProcess } from './claude-local-process'

let scratch: string | null = null
const groups: number[] = []
afterEach(async () => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL')
    } catch {
      // Gone, as it should be.
    }
  }
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

async function readNumber(path: string): Promise<number> {
  await until(async () => (await readFile(path, 'utf8').catch(() => '')).trim() !== '')
  return Number((await readFile(path, 'utf8')).trim())
}

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }

// A stand-in CLI whose MCP server wrapper started a server of its own, which
// the CLI's own shutdown would not reach. It writes its own pid, that
// server's, and whether a descriptor beyond stderr reached it.
function standInCli(dir: string): string[] {
  const script = [
    `echo $$ > '${join(dir, 'cli.pid')}'`,
    `if { : >&3; } 2>/dev/null; then echo open; else echo closed; fi > '${join(dir, 'fd3')}'`,
    `sleep 300 & echo $! > '${join(dir, 'grandchild.pid')}'`,
    'exec sleep 300',
  ].join('\n')
  return ['-c', script]
}

test.skipIf(process.platform === 'win32')(
  'what an MCP server the CLI started leaves behind ends with the CLI, whatever ended it',
  async () => {
    scratch = await mkdtemp(join(tmpdir(), 'claude-local-process-'))
    const cli = spawnClaudeLocalProcess('/bin/sh', standInCli(scratch), { env })
    groups.push(cli.pid!)
    const grandchild = await readNumber(join(scratch, 'grandchild.pid'))
    expect(alive(grandchild)).toBe(true)
    // The pid handed back is the CLI's own, and its group's, as it always was.
    expect(await readNumber(join(scratch, 'cli.pid'))).toBe(cli.pid)
    expect((await readFile(join(scratch, 'fd3'), 'utf8')).trim()).toBe('closed')

    const closed = new Promise((resolve) => cli.once('close', resolve))
    cli.kill('SIGTERM')
    await closed
    await until(() => !alive(grandchild))
    await until(() => !alive(-cli.pid!))
  },
)

test.skipIf(process.platform === 'win32')(
  'the CLI and what it started end when the process that started them is killed outright',
  async () => {
    scratch = await mkdtemp(join(tmpdir(), 'claude-local-process-'))
    // A stand-in server: it starts the CLI through the helper, says its pid,
    // and waits to be killed.
    const server = join(scratch, 'server.cjs')
    buildSync({
      stdin: {
        contents: [
          "import { spawnClaudeLocalProcess } from './claude-local-process'",
          `const cli = spawnClaudeLocalProcess('/bin/sh', ${JSON.stringify(standInCli(scratch))}, { env: ${JSON.stringify(env)} })`,
          'console.log(cli.pid)',
          'setInterval(() => {}, 1000)',
        ].join('\n'),
        resolveDir: import.meta.dirname,
        sourcefile: 'server.ts',
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: server,
      logLevel: 'silent',
    })
    const parent = spawn(process.execPath, [server], { stdio: ['ignore', 'pipe', 'inherit'] })
    const cliPid = await new Promise<number>((resolve) => parent.stdout.once('data', (data) => resolve(Number(data))))
    groups.push(cliPid)
    const grandchild = await readNumber(join(scratch, 'grandchild.pid'))
    expect(await readNumber(join(scratch, 'cli.pid'))).toBe(cliPid)

    const gone = new Promise((resolve) => parent.once('exit', resolve))
    parent.kill('SIGKILL')
    await gone
    await until(() => !alive(cliPid) && !alive(grandchild))
    // The watcher itself waits out its grace before the last kill takes it too.
    await until(() => !alive(-cliPid), 10_000)
  },
)

test.skipIf(process.platform === 'win32')('a CLI that is not there fails to start, as it did', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-local-process-'))
  const cli = spawnClaudeLocalProcess(join(scratch, 'claude'), [], { env })
  const outcome = await new Promise<string | undefined>((resolve) => {
    cli.once('error', (error: NodeJS.ErrnoException) => resolve(error.code))
    cli.once('exit', (code) => resolve(`exit ${code}`))
  })
  expect(outcome).toBe('ENOENT')
  expect(cli.pid).toBeUndefined()
})

test.skipIf(process.platform === 'win32')('a bare name that is not on PATH fails to start, as it did', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'claude-local-process-'))
  const cli = spawnClaudeLocalProcess('claude-not-installed-anywhere', [], { env: { PATH: scratch } })
  const outcome = await new Promise<string | undefined>((resolve) => {
    cli.once('error', (error: NodeJS.ErrnoException) => resolve(error.code))
    cli.once('exit', (code) => resolve(`exit ${code}`))
  })
  expect(outcome).toBe('ENOENT')
})
