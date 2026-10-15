import assert from 'node:assert/strict'
import {
  claudeChatTitleInvocation,
  codexChatTitleInvocation,
  codexMcpListInvocation,
  codexTextInvocation,
  readClaudeChatTitleStdout,
  readCodexChatTitleOutput,
  readCodexEnabledMcpServers,
} from './backends'
import { test } from 'vitest'

test('backends', async () => {
  const tests: Array<{ name: string; body: () => void }> = []
  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  run('claude runs print mode with structured output and every door shut', () => {
    const { file, args } = claudeChatTitleInvocation({
      binaryPath: '/usr/local/bin/claude',
      model: 'claude-haiku-4-5',
      reasoning: 'low',
      schemaJson: '{"type":"object"}',
    })
    assert.equal(file, '/usr/local/bin/claude')
    assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--json-schema', '{"type":"object"}'])
    assert.deepEqual(args.slice(5, 9), ['--model', 'claude-haiku-4-5', '--effort', 'low'])
    assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === '', 'no tools at all')
    assert.ok(args.includes('--disable-slash-commands'))
    assert.ok(args.includes('--strict-mcp-config'))
    assert.equal(args[args.indexOf('--settings') + 1], '{"disableAllHooks":true}')
  })

  run("claude leaves strict MCP mode off beside an administrator's managed-mcp.json, and every other door shut", () => {
    const { args } = claudeChatTitleInvocation({
      binaryPath: 'claude',
      model: 'fable',
      schemaJson: '{}',
      managedMcpConfig: true,
    })
    assert.ok(!args.includes('--strict-mcp-config'))
    assert.ok(args.includes('--disable-slash-commands'))
    assert.equal(args[args.indexOf('--tools') + 1], '')
  })

  run('claude passes no effort flag when none is chosen', () => {
    const { args } = claudeChatTitleInvocation({ binaryPath: 'claude', model: 'fable', schemaJson: '{}' })
    assert.ok(!args.includes('--effort'))
  })

  run('codex runs exec ephemeral, read-only, schema and last-message on files, prompt on stdin', () => {
    const { file, args } = codexChatTitleInvocation({
      binaryPath: '/opt/homebrew/bin/codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      schemaPath: '/tmp/x/schema.json',
      outputPath: '/tmp/x/last-message.txt',
    })
    assert.equal(file, '/opt/homebrew/bin/codex')
    assert.deepEqual(args.slice(0, 5), ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only'])
    assert.deepEqual(args.slice(5, 9), ['--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"'])
    assert.deepEqual(args.slice(9), [
      '-c',
      'features.plugins=false',
      '-c',
      'features.apps=false',
      '--output-schema',
      '/tmp/x/schema.json',
      '--output-last-message',
      '/tmp/x/last-message.txt',
      '-',
    ])
  })

  run('reads the claude envelope, verbose arrays, and refuses an error envelope', () => {
    assert.equal(
      readClaudeChatTitleStdout(
        '{"type":"result","is_error":false,"structured_output":{"title":"Sidebar flicker"},"result":"{\\"title\\":\\"Sidebar flicker\\"}"}',
      ),
      'Sidebar flicker',
    )
    assert.equal(
      readClaudeChatTitleStdout('[{"type":"system"},{"type":"result","structured_output":{"title":"From the array"}}]'),
      'From the array',
    )
    assert.equal(
      readClaudeChatTitleStdout('{"type":"result","result":"{\\"title\\":\\"Only in result\\"}"}'),
      'Only in result',
      'an envelope without structured_output still yields its result text',
    )
    assert.equal(readClaudeChatTitleStdout('{"type":"result","is_error":true,"result":"rate limited"}'), null)
    assert.equal(readClaudeChatTitleStdout('Error: not logged in'), null, 'non-JSON stdout is never a title')
    assert.equal(readClaudeChatTitleStdout('[]'), null)
  })

  run('reads the codex last-message file in any of its shapes', () => {
    assert.equal(readCodexChatTitleOutput('{"title":"Fix Mobile Sidebar Flicker"}\n'), 'Fix Mobile Sidebar Flicker')
    assert.equal(readCodexChatTitleOutput('Bare answer'), 'Bare answer')
    assert.equal(readCodexChatTitleOutput(''), null)
  })

  let failed = 0
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed += 1
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed > 0) throw new Error(`${failed} backends test(s) failed`)
})

test('codex turns each listed MCP server off by name in one inline table', () => {
  const { args } = codexChatTitleInvocation({
    binaryPath: 'codex',
    model: 'gpt-5.6-luna',
    schemaPath: '/tmp/x/schema.json',
    outputPath: '/tmp/x/last-message.txt',
    mcpServersOff: ['docs', 'my.server', 'say "hi"', 'a\u007fb'],
  })
  assert.deepEqual(args.slice(7, 13), [
    '-c',
    'features.plugins=false',
    '-c',
    'features.apps=false',
    '-c',
    // A dot stays inside its quoted key, a quote is escaped, and DEL, which
    // TOML refuses raw, is written as an escape.
    'mcp_servers={"docs"={enabled=false},"my.server"={enabled=false},"say \\"hi\\""={enabled=false},"a\\u007fb"={enabled=false}}',
  ])
})

test('codex free text turns MCP servers off the same way', () => {
  const { args } = codexTextInvocation({
    binaryPath: 'codex',
    model: 'gpt-5.6-luna',
    outputPath: '/tmp/out.txt',
    mcpServersOff: ['docs'],
  })
  assert.ok(args.includes('features.plugins=false') && args.includes('features.apps=false'))
  assert.equal(args[args.indexOf('--json') - 1], 'mcp_servers={"docs"={enabled=false}}')
})

test('codex lists its MCP servers with plugins and apps off', () => {
  assert.deepEqual(codexMcpListInvocation('/opt/homebrew/bin/codex'), {
    file: '/opt/homebrew/bin/codex',
    args: ['-c', 'features.plugins=false', '-c', 'features.apps=false', 'mcp', 'list', '--json'],
  })
})

test('only the servers codex mcp list reports enabled are read', () => {
  // The shape codex-cli 0.161.0 prints, trimmed to the keys that are read.
  const stdout = JSON.stringify([
    { name: 'docs', enabled: true, transport: { type: 'stdio', command: 'docs-mcp' } },
    { name: 'paused', enabled: false, disabled_reason: null },
    { name: 'my.server', enabled: true },
    { enabled: true },
  ])
  assert.deepEqual(readCodexEnabledMcpServers(stdout), ['docs', 'my.server'])
})

test.each(['', 'error: unexpected argument', '{"name":"docs","enabled":true}', 'null'])(
  'codex mcp list output %j that is not the list reads as no servers',
  (stdout) => {
    assert.deepEqual(readCodexEnabledMcpServers(stdout), [])
  },
)
