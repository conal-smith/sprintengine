import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A real `sshd` in a container for the phase 8 integration suites (spec 9.3),
// run only with `STUDIO_TEST_DOCKER=1` and a Docker that answers. Each
// fixture has its own container, user key, `known_hosts` and ssh config with
// one `Host build-box` entry, which the suites pass with `-F` so the
// person's own config is never read.

export const DOCKER_TESTS = process.env.STUDIO_TEST_DOCKER === '1' && spawnSync('docker', ['info']).status === 0

// The CI job builds this tag in a step of its own (.github/workflows/ci.yml); keep the two in step.
const IMAGE = 'sprintengine-test-sshd:1'
/** What one of the fixture's own docker calls may take: they are all quick, and a stuck one should say so. */
const DOCKER_CALL_MS = 60_000
/** A first build pulls Ubuntu and runs apt-get, which a slow mirror can stretch to minutes. */
export const SSHD_IMAGE_BUILD_MS = 15 * 60_000

let built = false
/**
 * Builds the image if this Docker does not have it yet. Call it from the
 * suite's `beforeAll` with `SSHD_IMAGE_BUILD_MS`: a first build is minutes of
 * apt-get, and it must neither count against a test's own deadline nor hold
 * the worker's event loop (a synchronous build did both: the test "timed out
 * in 120000ms" after 150-450 s of a slow mirror, with nothing hung).
 */
export async function prepareSshdImage(): Promise<void> {
  if (built) return
  const found = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: DOCKER_CALL_MS })
  if (found.status !== 0)
    await new Promise<void>((resolve, reject) => {
      execFile(
        'docker',
        ['build', '-q', '-t', IMAGE, '-f', join(__dirname, 'sshd.Dockerfile'), __dirname],
        { timeout: SSHD_IMAGE_BUILD_MS - 5_000, maxBuffer: 16 * 1024 * 1024 },
        (error, _stdout, stderr) =>
          error
            ? reject(new Error(`docker build ${IMAGE} failed: ${error.message}\n${stderr.slice(-4_000)}`))
            : resolve(),
      )
    })
  built = true
}

export type SshdFixture = {
  id: string
  port: number
  dir: string
  /** The `-F` config: `Host build-box` with this fixture's key and known_hosts. */
  configFile: string
  keyPath: string
  knownHosts: string
  /** A command in the container, as root, its stdout. */
  exec(command: string, user?: string): string
  pause(): void
  unpause(): void
  stop(): void
}

export type SshdOptions = {
  /** `sshd -o` lines: `AllowTcpForwarding no`, `AuthenticationMethods publickey,password`. */
  sshdOptions?: string[]
  /** A passphrase on the user key (asked through askpass). */
  passphrase?: string
  /** The home mounted noexec. */
  noexecHome?: boolean
  /** Extra lines for the client's Host entry. */
  clientLines?: string[]
  /** A docker network to join, and the name to be reached by on it. */
  network?: { name: string; alias: string }
  /** Publish port 22 on 127.0.0.1 (default); off for a machine reached only through a jump host. */
  publish?: boolean
  /** Reuse this key pair (a jump host and its target admit the same key). */
  keyPath?: string
}

export function startSshd(options: SshdOptions = {}): SshdFixture {
  if (!built)
    throw new Error(`startSshd: await prepareSshdImage() in the suite's beforeAll first, so ${IMAGE} is built there`)
  const image = IMAGE
  const dir = mkdtempSync(join(tmpdir(), 'se-sshd-'))
  const keyPath = options.keyPath ?? join(dir, 'id_ed25519')
  if (!options.keyPath)
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      options.passphrase ?? '',
      '-C',
      'dev@example.com',
      '-f',
      keyPath,
    ])
  const args = ['run', '-d', '--rm']
  if (options.publish !== false) args.push('-p', '127.0.0.1::22')
  if (options.network) args.push('--network', options.network.name, '--network-alias', options.network.alias)
  if (options.noexecHome) args.push('--tmpfs', '/home/dev:rw,noexec,uid=1000,gid=1000,mode=0755')
  args.push(image, '/usr/sbin/sshd', '-D', '-e', ...(options.sshdOptions ?? []).flatMap((line) => ['-o', line]))
  const id = execFileSync('docker', args, { encoding: 'utf8', timeout: DOCKER_CALL_MS }).trim()
  const exec = (command: string, user = 'root') =>
    execFileSync('docker', ['exec', '-u', user, id, 'sh', '-c', command], { encoding: 'utf8', timeout: DOCKER_CALL_MS })
  if (options.noexecHome) exec('mkdir -p /home/dev/.ssh && chown -R dev:dev /home/dev && chmod 700 /home/dev/.ssh')
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      id,
      'sh',
      '-c',
      'cat > /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys',
    ],
    { input: readFileSync(`${keyPath}.pub`), timeout: DOCKER_CALL_MS },
  )
  const port =
    options.publish === false
      ? 22
      : Number(
          execFileSync('docker', ['port', id, '22/tcp'], { encoding: 'utf8', timeout: DOCKER_CALL_MS })
            .trim()
            .split('\n')[0]!
            .split(':')
            .at(-1),
        )
  const knownHosts = join(dir, 'known_hosts')
  const configFile = join(dir, 'ssh_config')
  writeFileSync(
    configFile,
    [
      'Host build-box',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User dev',
      `  IdentityFile ${keyPath}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${knownHosts}`,
      ...(options.clientLines ?? []).map((line) => `  ${line}`),
      '',
    ].join('\n'),
  )
  // sshd answers a moment after the container starts; one that never does is said here, not as a hung test.
  let ready = options.publish === false
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    const probe = spawnSync('ssh-keyscan', ['-p', String(port), '127.0.0.1'], { encoding: 'utf8', timeout: 2_000 })
    ready = probe.stdout.includes('ssh-ed25519')
    if (!ready) spawnSync('sleep', ['0.2'])
  }
  if (!ready) {
    const logs = spawnSync('docker', ['logs', id], { encoding: 'utf8', timeout: DOCKER_CALL_MS })
    spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore', timeout: DOCKER_CALL_MS })
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`sshd in ${id.slice(0, 12)} never answered on 127.0.0.1:${port}:\n${logs.stdout}${logs.stderr}`)
  }
  return {
    id,
    port,
    dir,
    configFile,
    keyPath,
    knownHosts,
    exec,
    pause: () => void execFileSync('docker', ['pause', id]),
    unpause: () => void execFileSync('docker', ['unpause', id]),
    stop() {
      spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore', timeout: DOCKER_CALL_MS })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
