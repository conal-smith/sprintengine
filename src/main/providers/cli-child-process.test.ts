import { expect, test } from 'vitest'
import { cliSpawnTarget, terminateCliChild } from './cli-child-process'

const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'

test('a batch shim on Windows runs through the command processor with every argument quoted', () => {
  expect(cliSpawnTarget(shim, ['app-server', '--listen', 'stdio://'], { platform: 'win32', env: {} })).toEqual({
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `""${shim}" "app-server" "--listen" "stdio://""`],
    windowsVerbatimArguments: true,
  })
  expect(
    cliSpawnTarget('C:\\Program Files\\agent\\agent.BAT', ['acp'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    }).file,
  ).toBe('C:\\Windows\\System32\\cmd.exe')
})

test('a batch shim argument the command processor would reinterpret is refused', () => {
  expect(() => cliSpawnTarget(shim, ['%PATH%'], { platform: 'win32', env: {} })).toThrow('Cannot start')
  expect(() => cliSpawnTarget('C:\\Users\\dev\\"odd"\\codex.cmd', [], { platform: 'win32', env: {} })).toThrow(
    'Cannot start',
  )
})

const NPM_SHIM = (line: string, prog = 'node') =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    `  SET "_prog=${prog}"`,
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ${line}`,
    '',
  ].join('\r\n')

test('in a UNC folder an npm batch shim runs what it names directly, never through a shell', () => {
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
  const npm = 'C:\\Users\\dev\\AppData\\Roaming\\npm'
  const script = `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`
  const files: Record<string, string> = {
    [shim]: NPM_SHIM('"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'),
  }
  const nodeOnPath = 'C:\\Program Files\\nodejs\\node.exe'
  const present = new Set([script, nodeOnPath])
  const deps = {
    platform: 'win32' as const,
    env: { PATH: 'C:\\Program Files\\nodejs;.' },
    cwd,
    exists: (path: string) => present.has(path),
    readText: (path: string) => files[path] ?? null,
  }
  // Every argument is handed over as it is: Node quotes it for the CLI's own
  // parser, and no command processor or PowerShell reads it on the way.
  expect(cliSpawnTarget(shim, ['app-server', '-c', 'model="o3"', ''], deps)).toEqual({
    file: nodeOnPath,
    args: [script, 'app-server', '-c', 'model="o3"', ''],
  })
  // Node is named by its full path from PATH, never by a bare name the
  // workspace folder could answer: with none on PATH the shim is refused.
  present.delete(nodeOnPath)
  present.add(`${cwd}\\node.exe`)
  expect(() => cliSpawnTarget(shim, ['app-server'], deps)).toThrow('cannot start one in')
  present.add(nodeOnPath)
  present.add(`${npm}\\node.exe`)
  expect(cliSpawnTarget(shim, ['app-server'], deps).file).toBe(`${npm}\\node.exe`)

  // npm 6 wrote the program into the line itself.
  files[shim] = [
    '@IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ') ELSE (',
    '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    '  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ')',
  ].join('\r\n')
  expect(cliSpawnTarget(shim, ['app-server'], deps).args).toEqual([script, 'app-server'])

  // A package whose bin is an executable gets a shim with no program.
  const exe = `${npm}\\node_modules\\agent\\bin\\agent.exe`
  files[`${npm}\\agent.cmd`] = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\agent\\bin\\agent.exe"   %*',
    '',
  ].join('\r\n')
  present.add(exe)
  expect(cliSpawnTarget(`${npm}\\agent.cmd`, ['acp'], deps)).toEqual({ file: exe, args: ['acp'] })

  // Anything else is refused with the way out, rather than run in C:\Windows:
  // a hand-written batch file, a shim whose script is gone, one that runs
  // another program, or one that sets variables its program needs.
  files['C:\\tools\\agent.bat'] = '@echo off\r\nnode "%~dp0agent.js" %*\r\n'
  expect(() => cliSpawnTarget('C:\\tools\\agent.bat', ['acp'], deps)).toThrow('cannot start one in')
  present.delete(script)
  files[shim] = NPM_SHIM('"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*')
  expect(() => cliSpawnTarget(shim, ['app-server'], deps)).toThrow('cannot start one in')
  present.add(script)
  files[shim] = NPM_SHIM('"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', 'sh')
  expect(() => cliSpawnTarget(shim, ['app-server'], deps)).toThrow('cannot start one in')
  files[shim] =
    `@SET "NODE_PATH=%~dp0\\lib"\r\n${NPM_SHIM('"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*')}`
  expect(() => cliSpawnTarget(shim, ['app-server'], deps)).toThrow('cannot start one in')

  // A folder on a drive keeps the command processor, and an executable is
  // spawned directly wherever it runs.
  expect(cliSpawnTarget(shim, ['app-server'], { ...deps, cwd: 'C:\\Users\\dev\\repo' }).file).toBe('cmd.exe')
  expect(cliSpawnTarget('C:\\tools\\grok.exe', ['stdio'], { platform: 'win32', cwd }).file).toBe('C:\\tools\\grok.exe')
})

test('a PowerShell shim runs through PowerShell and executables are spawned directly', () => {
  expect(
    cliSpawnTarget('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.ps1', ['acp'], {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      cwd: 'C:\\Users\\dev\\repo',
    }),
  ).toEqual({
    // By its full path: a bare name is looked for in the workspace first.
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.ps1',
      'acp',
    ],
  })
  expect(cliSpawnTarget('C:\\tools\\grok.exe', ['stdio'], { platform: 'win32' })).toEqual({
    file: 'C:\\tools\\grok.exe',
    args: ['stdio'],
  })
  expect(cliSpawnTarget('/Users/dev/bin/codex.cmd', ['app-server'], { platform: 'darwin' })).toEqual({
    file: '/Users/dev/bin/codex.cmd',
    args: ['app-server'],
  })
})

test('stopping a CLI child ends its whole tree on Windows and escalates elsewhere', () => {
  const signals: unknown[] = []
  const child = { pid: 4242, exitCode: null, kill: (signal?: unknown) => signals.push(signal) > 0 }
  const killed: number[] = []
  terminateCliChild(child, { platform: 'win32', runTaskkill: (pid) => killed.push(pid) })
  expect(killed).toEqual([4242])
  expect(signals).toEqual([])
  terminateCliChild(child, { platform: 'darwin' })
  expect(signals).toEqual(['SIGTERM'])
  terminateCliChild({ ...child, exitCode: 0 }, { platform: 'win32', runTaskkill: (pid) => killed.push(pid) })
  expect(killed).toEqual([4242])
})
