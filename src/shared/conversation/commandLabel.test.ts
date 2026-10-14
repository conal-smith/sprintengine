import assert from 'node:assert/strict'
import { test } from 'vitest'
import { labelCommand, type CommandKind } from './commandLabel'

type Expected = [string, string, CommandKind]

test('labels shell commands from a broad command table', () => {
  const cases: Array<[string, ...Expected]> = [
    ['cd app && npx vitest run a.test.ts | tail -20', 'Ran vitest', 'vitest', 'test'],
    ['pushd app; git status', 'git status', 'git', 'git'],
    ['export FOO=1 && rg hello src', 'Searched for "hello"', 'rg', 'search'],
    ['set -e\nls', 'Listed .', 'ls', 'list'],
    ['source env.sh && npm test', 'Ran npm script test', 'npm', 'test'],
    ['. ./env && npm run build', 'Ran npm script build', 'npm', 'build'],
    ['unset A; cat file.txt', 'Read file.txt', 'cat', 'read'],
    ['ulimit -n 10 && ls', 'Listed .', 'ls', 'list'],
    ['umask 022 && ls', 'Listed .', 'ls', 'list'],
    ['A=1 B=2 rg pattern file', 'Searched for "pattern"', 'rg', 'search'],
    ['rg "hello world" src', 'Searched for "hello world"', 'rg', 'search'],
    ["rg 'hello world' src", 'Searched for "hello world"', 'rg', 'search'],
    ['rg hello\\ world src', 'Searched for "hello world"', 'rg', 'search'],
    ['rg hello || echo nope', 'Searched for "hello"', 'rg', 'search'],
    ['rg hello & cat file', 'Searched for "hello"', 'rg', 'search'],
    ['rg hello | head', 'Searched for "hello"', 'rg', 'search'],
    ['rg hello | grep x', 'Searched for "hello"', 'rg', 'search'],
    ['rg hello | sort', 'Searched for "hello"', 'rg', 'search'],
    ['rg hello | jq .', 'Searched for "hello"', 'rg', 'search'],
    ['env A=1 npm test', 'Ran npm script test', 'npm', 'test'],
    ['sudo -n npm test', 'Ran npm script test', 'npm', 'test'],
    ['time npm test', 'Ran npm script test', 'npm', 'test'],
    ['nohup npm test', 'Ran npm script test', 'npm', 'test'],
    ['nice -n 5 npm test', 'Ran npm script test', 'npm', 'test'],
    ['command npm test', 'Ran npm script test', 'npm', 'test'],
    ['exec npm test', 'Ran npm script test', 'npm', 'test'],
    ['stdbuf -oL npm test', 'Ran npm script test', 'npm', 'test'],
    ['timeout 10s npm test', 'Ran npm script test', 'npm', 'test'],
    ['caffeinate -i npm test', 'Ran npm script test', 'npm', 'test'],
    ['arch -arm64 npm test', 'Ran npm script test', 'npm', 'test'],
    ['bash -c "npm test"', 'Ran npm script test', 'npm', 'test'],
    ['sh -lc "npm test"', 'Ran npm script test', 'npm', 'test'],
    ['zsh -c "npm test"', 'Ran npm script test', 'npm', 'test'],
    ['fish -c "npm test"', 'Ran npm script test', 'npm', 'test'],
    ['bash -c "sh -c \'npm test\'"', 'Ran npm script test', 'npm', 'test'],
    ['npx vitest run', 'Ran vitest', 'vitest', 'test'],
    ['bunx vitest run', 'Ran vitest', 'vitest', 'test'],
    ['pnpm dlx vitest run', 'Ran vitest', 'vitest', 'test'],
    ['yarn dlx vitest run', 'Ran vitest', 'vitest', 'test'],
    ['uvx pytest', 'Ran pytest', 'pytest', 'test'],
    ['pipx run pytest', 'Ran pytest', 'pytest', 'test'],
    ['npx vitest@2.0.0 run', 'Ran vitest', 'vitest', 'test'],
    ['npm run test:unit', 'Ran npm script test:unit', 'npm', 'test'],
    ['npm test', 'Ran npm script test', 'npm', 'test'],
    ['pnpm build', 'Ran pnpm script build', 'pnpm', 'build'],
    ['yarn lint', 'Ran yarn script lint', 'yarn', 'lint'],
    ['bun run format', 'Ran bun script format', 'bun', 'format'],
    ['npm run typecheck', 'Ran npm script typecheck', 'npm', 'test'],
    ['npm run dev', 'Ran npm script dev', 'npm', 'script'],
    ['npm run start', 'Ran npm script start', 'npm', 'script'],
    ['node src/main.js', 'Ran main.js', 'node', 'script'],
    ['python script.py', 'Ran script.py', 'python', 'script'],
    ['python3 script.py', 'Ran script.py', 'python3', 'script'],
    ['ruby script.rb', 'Ran script.rb', 'ruby', 'script'],
    ['deno run script.ts', 'Ran script.ts', 'deno', 'script'],
    ['bun script.ts', 'Ran script.ts', 'bun', 'script'],
    ['tsx src/a.ts', 'Ran a.ts', 'tsx', 'script'],
    ['ts-node src/a.ts', 'Ran a.ts', 'ts-node', 'script'],
    ['node -e "console.log(1)"', 'Ran node snippet', 'node', 'script'],
    ['python -c "print(1)"', 'Ran python snippet', 'python', 'script'],
    ['node - <<EOF\nconsole.log(1)\nEOF', 'Ran node script', 'node', 'script'],
    ['python <<EOF\nprint(1)\nEOF', 'Ran python script', 'python', 'script'],
    ['cat <<EOF > out.txt', 'Wrote out.txt', 'cat', 'write'],
    ['tee out.txt <<EOF', 'Wrote out.txt', 'tee', 'write'],
    ['cat a.txt', 'Read a.txt', 'cat', 'read'],
    ['head a.txt', 'Read a.txt', 'head', 'read'],
    ['tail a.txt', 'Read a.txt', 'tail', 'read'],
    ['less a.txt', 'Read a.txt', 'less', 'read'],
    ['more a.txt', 'Read a.txt', 'more', 'read'],
    ['bat a.txt', 'Read a.txt', 'bat', 'read'],
    ['nl a.txt', 'Read a.txt', 'nl', 'read'],
    ["sed -n '1,5p' a.txt", 'Read a.txt', 'sed', 'read'],
    ['cat a.txt b.txt', 'Read 2 files', 'cat', 'read'],
    ['grep pattern src', 'Searched for "pattern"', 'grep', 'search'],
    ['ag pattern src', 'Searched for "pattern"', 'ag', 'search'],
    ['ack pattern src', 'Searched for "pattern"', 'ack', 'search'],
    ['find . -name x', 'Searched files', 'find', 'search'],
    ['fd x src', 'Searched files', 'fd', 'search'],
    ['ls', 'Listed .', 'ls', 'list'],
    ['tree src', 'Listed src', 'tree', 'list'],
    ['exa src', 'Listed src', 'exa', 'list'],
    ['eza src', 'Listed src', 'eza', 'list'],
    ['git status', 'git status', 'git', 'git'],
    ['git -C repo status', 'git status', 'git', 'git'],
    ['git -c color.ui=never status', 'git status', 'git', 'git'],
    ['git -C repo -c color.ui=never diff', 'git diff', 'git', 'git'],
    ['echo hello > out.txt', 'Wrote out.txt', 'echo', 'write'],
    ['printf hello >> out.txt', 'Wrote out.txt', 'printf', 'write'],
    ['powershell -Command "Get-Content a.txt"', 'Read a.txt', 'Get-Content', 'read'],
    ['pwsh -c "Set-Content a.txt"', 'Wrote a.txt', 'Set-Content', 'write'],
    ['Get-Content a.txt', 'Read a.txt', 'Get-Content', 'read'],
    ['Out-File a.txt', 'Wrote a.txt', 'Out-File', 'write'],
    ['Add-Content a.txt', 'Wrote a.txt', 'Add-Content', 'write'],
    ['Get-ChildItem src', 'Listed src', 'Get-ChildItem', 'list'],
    ['Select-String needle src', 'Searched for needle', 'Select-String', 'search'],
    ['Remove-Item a.txt', 'Deleted a.txt', 'Remove-Item', 'edit'],
    ['gc a.txt', 'Read a.txt', 'gc', 'read'],
    ['gci src', 'Listed src', 'gci', 'list'],
    ['sls needle src', 'Searched for needle', 'sls', 'search'],
    ['ri a.txt', 'Deleted a.txt', 'ri', 'edit'],
    ['unknown-tool arg', 'Ran unknown-tool', 'unknown-tool', 'run'],
    ['/usr/bin/custom.exe arg', 'Ran custom', 'custom', 'run'],
    ['', 'Ran command', '', 'run'],
    ['   ', 'Ran command', '', 'run'],
    ['"unbalanced command', 'Ran unbalanced command', 'unbalanced command', 'run'],
  ]
  const prefixVariants = ['cd app && ', 'A=1 ', 'env A=1 ', 'sudo -n ', 'time ', 'nohup ', 'command ', 'exec ']
  for (const prefix of prefixVariants) {
    for (const command of ['git status', 'npm test', 'rg needle src', 'cat file.txt', 'ls src', 'npx vitest run']) {
      const base = labelCommand(command)
      cases.push([prefix + command, base.label, base.program, base.kind])
    }
  }
  assert.ok(cases.length >= 150)
  for (const [input, label, program, kind] of cases) {
    const result = labelCommand(input)
    assert.deepEqual([result.label, result.program, result.kind], [label, program, kind], input)
    assert.ok(result.label.length <= 60, input)
  }
  assert.deepEqual(labelCommand(['git', 'status']), labelCommand('git status'))
  assert.equal(labelCommand('rg ' + 'x'.repeat(100)).kind, 'search')
})

test('labels arbitrary command strings within a bounded time', () => {
  let seed = 12
  const cpuStart = process.cpuUsage()
  let maximumWallMs = 0
  for (let i = 0; i < 10_000; i++) {
    let input = ''
    for (let j = 0, n = i % 80; j < n; j++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      input += String.fromCharCode(32 + (seed % 95))
    }
    const start = performance.now()
    const result = labelCommand(input)
    maximumWallMs = Math.max(maximumWallMs, performance.now() - start)
    assert.ok(result.label.length <= 60)
  }
  const cpu = process.cpuUsage(cpuStart)
  const meanCpuMs = (cpu.user + cpu.system) / 1000 / 10_000
  // Process scheduling/GC can pause one wall sample independently of this pure
  // function. Enforce the budget with amortized CPU and retain worst-wall data.
  assert.ok(meanCpuMs < 2, `Mean command-label CPU ${meanCpuMs}ms exceeds 2ms`)
  console.info(`Command-label 10k fuzz: mean CPU ${meanCpuMs.toFixed(4)}ms; max wall ${maximumWallMs.toFixed(4)}ms`)
})

test('option operands do not become wrapper commands, search patterns or read targets', () => {
  for (const [command, expected] of [
    ['head -n 20 README.md', 'Read README.md'],
    ['tail -c 50 README.md', 'Read README.md'],
    ['head --lines=20 README.md', 'Read README.md'],
    ['head -n20 README.md', 'Read README.md'],
    ['head -n 20 one.md two.md', 'Read 2 files'],
    ['cat -- -notes.md', 'Read -notes.md'],
    ['cat -n README.md', 'Read README.md'],
    ['rg -g *.ts needle src', 'Searched for "needle"'],
    ['rg --glob=*.ts needle src', 'Searched for "needle"'],
    ['rg -t ts -C 3 needle src', 'Searched for "needle"'],
    ['grep -e needle --include *.ts src', 'Searched for "needle"'],
    ['grep -E needle src', 'Searched for "needle"'],
    ['rg --regexp=needle src', 'Searched for "needle"'],
    ['rg -- -needle src', 'Searched for "-needle"'],
    ['sudo -u root npm test', 'Ran npm script test'],
    ['sudo --user=root -n npm test', 'Ran npm script test'],
    ['sudo -g staff -u root -- npm test', 'Ran npm script test'],
    ['env -u HOME npm test', 'Ran npm script test'],
    ['env --unset=HOME FOO=1 npm test', 'Ran npm script test'],
    ['timeout -k 1s 10s npm test', 'Ran npm script test'],
    ['stdbuf -o L npm test', 'Ran npm script test'],
    ['caffeinate -t 30 npm test', 'Ran npm script test'],
  ])
    assert.equal(labelCommand(command).label, expected, command)
})

test('redirections, runner options and package manager subcommands are not arguments', () => {
  for (const [command, expected] of [
    ['cat f.txt 2>/dev/null', 'Read f.txt'],
    ['cat f.txt 2> /dev/null', 'Read f.txt'],
    ['ls 2>/dev/null', 'Listed .'],
    ['ls src 2>&1 | head', 'Listed src'],
    ['npm test 2>&1 | tail -20', 'Ran npm script test'],
    ['rg needle src &>/dev/null', 'Searched for "needle"'],
    ['cat a > b', 'Wrote b'],
    ['cat a >> notes/b.md', 'Wrote b.md'],
    ['cat a > /dev/null', 'Read a'],
    ['head -n 5 a.txt > top.txt', 'Wrote top.txt'],
    ['echo hi 1> out.txt', 'Wrote out.txt'],
    ['echo hi 2> err.txt', 'Ran echo'],
    ['git --no-pager diff', 'git diff'],
    ['git --no-pager -C repo log', 'git log'],
    ['git --git-dir=.git --work-tree . status', 'git status'],
    ['npx -y create-vite', 'Ran create-vite'],
    ['npx --yes -p typescript tsc', 'Ran tsc'],
    ['uvx --from ruff ruff check', 'Ran ruff'],
    ['pnpm dlx -p cowsay cowsay hi', 'Ran cowsay'],
    ['npm ci', 'Installed dependencies'],
    ['npm i', 'Installed dependencies'],
    ['npm i x', 'Installed x'],
    ['npm install -D vitest', 'Installed vitest'],
    ['pnpm add react react-dom', 'Installed 2 packages'],
    ['yarn remove lodash', 'Removed lodash'],
    ['npm exec tsc', 'Ran tsc'],
    ['npm exec vitest', 'Ran vitest'],
    ['npm exec -- vitest run', 'Ran vitest'],
    ['npm x --package=typescript tsc', 'Ran tsc'],
    ['npm exec -p typescript tsc', 'Ran tsc'],
    ['pnpm exec prettier --check .', 'Ran prettier'],
    ['yarn exec eslint .', 'Ran eslint'],
    ['bun x vitest', 'Ran vitest'],
    ['yarn', 'Installed dependencies'],
    ['yarn --frozen-lockfile', 'Installed dependencies'],
    ['cd app && yarn', 'Installed dependencies'],
    ['npm run-script build', 'Ran npm script build'],
    ["rg $'foo' src", 'Searched for "foo"'],
    ["rg $'a\\tb' src", 'Searched for "a\tb"'],
    ["rg $'it\\'s' src", 'Searched for "it\'s"'],
  ])
    assert.equal(labelCommand(command).label, expected, command)
  assert.equal(labelCommand('cat a > b').kind, 'write')
  assert.equal(labelCommand('npm ci').kind, 'install')
  assert.equal(labelCommand('yarn').kind, 'install')
  assert.equal(labelCommand('npm exec vitest').kind, 'test')
})

test('shell grammar is never named as the program that ran', () => {
  for (const command of [
    'if test -f package.json; then npm test; fi',
    '[ -f package.json ]',
    '[[ -f package.json ]]',
    'test -f package.json',
    'for file in *; do echo "$file"; done',
    'while true; do sleep 1; done',
    'until false; do sleep 1; done',
    'case $name in test) npm test;; esac',
    'select item in one two; do echo "$item"; done',
    'function check() { npm test; }',
    'check() { npm test; }',
    '(( count += 1 ))',
    ':',
    'true',
  ]) {
    assert.deepEqual(labelCommand(command), { label: 'Ran command', program: '', kind: 'run' }, command)
  }
})

test('a subshell, a group, a negation or an eval is labelled by the command it runs', () => {
  for (const command of ['(npm test)', '(cd apps && npm test)', '{ npm test; }', '! npm test', "eval 'npm test'"]) {
    assert.deepEqual(
      labelCommand(command),
      { label: 'Ran npm script test', program: 'npm', kind: 'test', target: 'test' },
      command,
    )
  }
  // The words only look like grammar inside an argument.
  assert.equal(labelCommand('rg -n "if|for|while" src').program, 'rg')
  assert.equal(labelCommand('node -e "if (true) console.log(1)"').program, 'node')
})
