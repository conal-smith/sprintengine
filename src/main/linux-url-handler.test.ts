import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  escapeExecArgument,
  escapeExecProgram,
  isOwnUrlHandlerEntry,
  registerLinuxUrlHandler,
  renderUrlHandlerEntry,
  type ExecResult,
  type LinuxUrlHandlerDeps,
} from './linux-url-handler'

const HOME = '/home/dev'
const APPS = '/home/dev/.local/share/applications'
const ENTRY = `${APPS}/sprintengine-url-handler.desktop`
const APPIMAGE = '/home/dev/Applications/SprintEngine-Studio.AppImage'
const MIME = 'x-scheme-handler/sprintengine'

type Options = {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  env?: NodeJS.ProcessEnv
  files?: Record<string, string>
  /** What `xdg-mime query default` prints. */
  currentDefault?: string
  /** Programs that are not installed. */
  missing?: string[]
  /** Programs that run and fail. */
  failing?: string[]
  unwritable?: boolean
}

function harness(options: Options = {}) {
  const files = new Map(Object.entries(options.files ?? {}))
  const writes: string[] = []
  const commands: string[] = []
  const logs: string[] = []
  const recorded: string[] = []
  const deps: LinuxUrlHandlerDeps = {
    platform: options.platform ?? 'linux',
    isPackaged: options.isPackaged ?? true,
    env: options.env ?? { APPIMAGE },
    homeDir: HOME,
    readFile: async (path) => {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
    writeFile: async (path, content) => {
      if (options.unwritable) throw new Error(`EACCES: ${path}`)
      writes.push(path)
      files.set(path, content)
    },
    mkdir: async () => undefined,
    exec: async (file, args): Promise<ExecResult> => {
      commands.push([file, ...args].join(' '))
      if (options.missing?.includes(file)) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      if (options.failing?.includes(file)) return { code: 1, stdout: '' }
      if (file === 'xdg-mime' && args[0] === 'query') return { code: 0, stdout: `${options.currentDefault ?? ''}\n` }
      return { code: 0, stdout: '' }
    },
    log: (level, message) => void logs.push(`${level}: ${message}`),
    record: (path, scheme) => void recorded.push(`${scheme} ${path}`),
  }
  return {
    run: () => registerLinuxUrlHandler(deps, ['sprintengine']),
    files,
    writes,
    commands,
    logs,
    recorded,
  }
}

test('nothing happens off Linux, in a build that is not packaged, or outside an AppImage', async () => {
  for (const options of [
    { platform: 'darwin' as const },
    { platform: 'win32' as const },
    { isPackaged: false },
    { env: {} },
    { env: { APPIMAGE: 'relative/SprintEngine-Studio.AppImage' } },
  ]) {
    const h = harness(options)
    await h.run()
    assert.deepEqual(h.writes, [], JSON.stringify(options))
    assert.deepEqual(h.commands, [], JSON.stringify(options))
    assert.deepEqual(h.recorded, [], JSON.stringify(options))
  }
})

test('a missing entry is written, the MIME cache refreshed, and it is made the default', async () => {
  const h = harness()
  await h.run()
  assert.deepEqual(h.writes, [ENTRY])
  const text = h.files.get(ENTRY) ?? ''
  assert.match(text, /^\[Desktop Entry\]\n/u)
  assert.ok(text.includes(`Exec=${APPIMAGE} %U\n`))
  assert.ok(text.includes('NoDisplay=true\n'))
  assert.ok(text.includes(`MimeType=${MIME};\n`))
  assert.ok(isOwnUrlHandlerEntry(text))
  assert.deepEqual(h.commands, [
    `update-desktop-database ${APPS}`,
    `xdg-mime query default ${MIME}`,
    `xdg-mime default sprintengine-url-handler.desktop ${MIME}`,
  ])
  assert.deepEqual(h.recorded, [`sprintengine ${ENTRY}`])
})

test('XDG_DATA_HOME, when it is an absolute path, is where the entry goes', async () => {
  const h = harness({ env: { APPIMAGE, XDG_DATA_HOME: '/home/dev/.data' } })
  await h.run()
  assert.deepEqual(h.writes, ['/home/dev/.data/applications/sprintengine-url-handler.desktop'])
  const relative = harness({ env: { APPIMAGE, XDG_DATA_HOME: 'data' } })
  await relative.run()
  assert.deepEqual(relative.writes, [ENTRY], 'a relative XDG_DATA_HOME is ignored')
})

test('a current entry that is already the default is left alone', async () => {
  const h = harness({
    files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', APPIMAGE) },
    currentDefault: 'sprintengine-url-handler.desktop',
  })
  await h.run()
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.commands, [`xdg-mime query default ${MIME}`])
  assert.deepEqual(h.recorded, [`sprintengine ${ENTRY}`], 'listed in the ledger even when nothing was written')
})

test('a default the person or another app chose is theirs: it is not taken back at the next start', async () => {
  for (const [label, files] of [
    ['an entry in the home', { [`${APPS}/other-app.desktop`]: '[Desktop Entry]\n' }],
    ['a system entry', { '/usr/share/applications/other-app.desktop': '[Desktop Entry]\n' }],
    ['one in a subdirectory', { '/usr/share/applications/other/app.desktop': '[Desktop Entry]\n' }],
  ] as const) {
    const h = harness({
      files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', APPIMAGE), ...files },
      currentDefault: 'other-app.desktop',
    })
    await h.run()
    assert.deepEqual(h.writes, [], label)
    assert.deepEqual(h.commands, [`xdg-mime query default ${MIME}`], label)
    assert.deepEqual(h.recorded, [`sprintengine ${ENTRY}`], label)
  }
  // The same on a first start: the entry is written, the choice kept.
  const first = harness({
    files: { [`${APPS}/other-app.desktop`]: '[Desktop Entry]\n' },
    currentDefault: 'other-app.desktop',
  })
  await first.run()
  assert.deepEqual(first.writes, [ENTRY])
  assert.deepEqual(first.commands, [`update-desktop-database ${APPS}`, `xdg-mime query default ${MIME}`])
})

test('a default that names an entry no longer on the machine is claimed', async () => {
  const h = harness({
    env: { APPIMAGE, XDG_DATA_DIRS: '/opt/share' },
    files: {
      [ENTRY]: renderUrlHandlerEntry('sprintengine', APPIMAGE),
      // Where the default XDG_DATA_DIRS would look, but not this machine's.
      '/usr/share/applications/removed-app.desktop': '[Desktop Entry]\n',
    },
    currentDefault: 'removed-app.desktop',
  })
  await h.run()
  assert.deepEqual(h.commands, [
    `xdg-mime query default ${MIME}`,
    `xdg-mime default sprintengine-url-handler.desktop ${MIME}`,
  ])
})

test('a file of the entry’s name the app did not write is left alone', async () => {
  const theirs =
    '[Desktop Entry]\nType=Application\nName=Mine\nExec=/opt/mine %U\nMimeType=x-scheme-handler/sprintengine;\n'
  const h = harness({ files: { [ENTRY]: theirs } })
  await h.run()
  assert.deepEqual(h.writes, [])
  assert.equal(h.files.get(ENTRY), theirs)
  assert.deepEqual(h.commands, [], 'nor is the scheme’s default touched')
  assert.deepEqual(h.recorded, [], 'nor is it listed as the app’s, so removal leaves it too')
  assert.deepEqual(h.logs, ['info: Left a link handler entry the app did not write'])
})

test('an entry written for an AppImage that has moved is rewritten and registered again', async () => {
  const h = harness({
    files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', '/home/dev/Downloads/SprintEngine-Studio.AppImage') },
    currentDefault: 'sprintengine-url-handler.desktop',
  })
  await h.run()
  assert.deepEqual(h.writes, [ENTRY])
  assert.ok(h.files.get(ENTRY)?.includes(`Exec=${APPIMAGE} %U`))
  assert.deepEqual(h.commands, [`update-desktop-database ${APPS}`, `xdg-mime query default ${MIME}`])
})

test('the AppImage path is quoted and escaped by the desktop-entry Exec rules', () => {
  assert.equal(escapeExecArgument('/home/dev/My Apps/Studio.AppImage'), '"/home/dev/My Apps/Studio.AppImage"')
  // Quote, backtick and dollar get a backslash inside the quotes, which the
  // file's string escaping then doubles, so a backslash ends up as four; a
  // percent sign is doubled so it is not read as a field code. Each `\\` in
  // the expected strings is one backslash in the file.
  assert.equal(
    escapeExecArgument('/home/dev/"q"/a`b`/$HOME/100%.AppImage'),
    '"/home/dev/\\\\"q\\\\"/a\\\\`b\\\\`/\\\\$HOME/100%%.AppImage"',
  )
  assert.equal(escapeExecArgument('/home/dev/back\\slash'), '"/home/dev/back\\\\\\\\slash"')
  assert.equal(escapeExecArgument('/home/dev/tab\there'), '"/home/dev/tab\\there"')
  const text = renderUrlHandlerEntry('sprintengine', '/home/dev/My Apps/50% off.AppImage')
  assert.ok(text.includes('Exec="/home/dev/My Apps/50%% off.AppImage" %U\n'))
})

test('the AppImage path is quoted only when the Exec rules require it', () => {
  // xdg-open's generic fallback runs `command -v` on the first Exec word as
  // written, quotes included, so a plain path is left bare.
  assert.equal(escapeExecProgram(APPIMAGE), APPIMAGE)
  assert.equal(escapeExecProgram('/home/dev/Apps/100%.AppImage'), '/home/dev/Apps/100%%.AppImage')
  assert.equal(escapeExecProgram('/home/dev/My Apps/Studio.AppImage'), '"/home/dev/My Apps/Studio.AppImage"')
  assert.equal(escapeExecProgram('/opt/Studio (beta)/x.AppImage'), '"/opt/Studio (beta)/x.AppImage"')
  assert.equal(escapeExecProgram('/home/dev/~apps/x.AppImage'), '"/home/dev/~apps/x.AppImage"')
  assert.equal(escapeExecProgram('/home/dev/$HOME/x.AppImage'), '"/home/dev/\\\\$HOME/x.AppImage"')
})

test('a missing xdg-mime or update-desktop-database is logged and swallowed', async () => {
  const h = harness({ missing: ['update-desktop-database', 'xdg-mime'] })
  await h.run()
  assert.deepEqual(h.writes, [ENTRY], 'the entry is still written')
  assert.deepEqual(h.logs, ['warning: update-desktop-database could not be run', 'warning: xdg-mime could not be run'])
})

test('a command that fails is logged, and the default is still set when only the cache refresh failed', async () => {
  const h = harness({ failing: ['update-desktop-database'] })
  await h.run()
  assert.ok(h.commands.includes(`xdg-mime default sprintengine-url-handler.desktop ${MIME}`))
  assert.deepEqual(h.logs, ['warning: update-desktop-database did not succeed', 'info: Registered the link handler'])

  const current = harness({
    files: { [ENTRY]: renderUrlHandlerEntry('sprintengine', APPIMAGE) },
    failing: ['xdg-mime'],
  })
  await current.run()
  assert.deepEqual(current.commands, [`xdg-mime query default ${MIME}`], 'an unanswered query changes nothing')
  assert.deepEqual(current.logs, ['warning: xdg-mime did not succeed'])
})

test('a home that cannot be written is logged, and nothing is recorded or registered', async () => {
  const h = harness({ unwritable: true })
  await h.run()
  assert.deepEqual(h.commands, [])
  assert.deepEqual(h.recorded, [])
  assert.deepEqual(h.logs, ['warning: The link handler could not be registered'])
})

// The legacy AppImage runtime electron-builder defaults to loads libfuse.so.2,
// which Ubuntu 24.04 and other FUSE3-only systems no longer install, and the
// AppImage then does not start at all. The static runtime carries its own
// FUSE code and sets APPIMAGE for the handler above as the legacy one did.
test('the AppImage is built on the static runtime, which needs no libfuse2', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    build: { toolsets?: { appimage?: string } }
  }
  assert.equal(pkg.build.toolsets?.appimage, '1.0.3')
})
