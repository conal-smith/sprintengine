// The extension guide: the topic list and the files in guide/ are the same
// set, every topic one names exists, and nothing in it still sends an agent
// to the skill it replaced.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import {
  EXTENSION_GUIDE_TOPICS,
  defaultGuideRoot,
  isExtensionGuideTopic,
  readExtensionGuideTopic,
} from '../src/guide.js'

const GUIDE = join(process.cwd(), 'packages/module-sdk/guide')
const ids = EXTENSION_GUIDE_TOPICS.map((topic) => topic.id)

test('every topic is a file in guide/, and every file a topic', () => {
  assert.equal(defaultGuideRoot(), GUIDE)
  const files = readdirSync(GUIDE)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
  assert.deepEqual([...files].sort(), [...ids].sort())
  assert.equal(ids[0], 'start', 'start is read first')
  assert.equal(new Set(ids).size, ids.length)
})

test('a topic is read by its id only, never by a path', () => {
  assert.match(readExtensionGuideTopic('start') ?? '', /^# Building a SprintEngine Studio extension/)
  for (const id of ['../package', 'start.md', '/etc/passwd', '', 'Start']) {
    assert.equal(isExtensionGuideTopic(id), false, id)
    assert.equal(readExtensionGuideTopic(id), null, id)
  }
})

test('the topics a topic names exist, and none links a file or names the old skill', () => {
  for (const id of ids) {
    const text = readFileSync(join(GUIDE, `${id}.md`), 'utf8')
    for (const [, named] of text.matchAll(/the `([a-z-]+)` topic/g)) {
      assert.ok(ids.includes(named!), `${id}.md names a "${named}" topic that does not exist`)
    }
    assert.doesNotMatch(text, /\]\([a-z-]+\.md\)/, `${id}.md links a file; name the topic instead`)
    assert.doesNotMatch(text, /extension-builder|references\//, `${id}.md still points at the skill`)
  }
  const start = readExtensionGuideTopic('start') ?? ''
  for (const id of ids.filter((topic) => topic !== 'start')) {
    assert.ok(start.includes(`| \`${id}\` |`), `start's table of topics leaves out "${id}"`)
  }
})
