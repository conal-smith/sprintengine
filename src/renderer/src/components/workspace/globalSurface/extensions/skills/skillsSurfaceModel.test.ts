import assert from 'node:assert/strict'

import type {
  ScanResult,
  ScannedSkill,
  SkillDiscoveryCondition,
  SkillFileRef,
  SkillSource,
} from '../../../../../../../shared/skills'
import {
  addedRepoKeys,
  createSkillSearchScheduler,
  describeSearchBudget,
  discoverNoticeTone,
  formatStars,
  isRepoAdded,
  SKILL_SEARCH_DEBOUNCE_MS,
} from './discoverModel'
import {
  defaultSkillFilePath,
  skillPluginFolder,
  deriveSkillCatalogueGroups,
  bundledScanLine,
  deriveInstallAvailability,
  describeDeadSkillLink,
  formatSkillFileSize,
  isMarkdownSkillFile,
  orderSkillFiles,
  resolveSkillLink,
  skillGroupLabel,
  stripSkillFrontmatter,
  skillSourceCommitsUrl,
  summarizeInstallRun,
  summarizeSyncRun,
} from './skillsSurfaceModel'
import { test } from 'vitest'

test('skillsSurfaceModel', async () => {
  // The Skills surface lists what a source's scan actually found.

  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function skill(id: string, over: Partial<ScannedSkill> = {}): ScannedSkill {
    const name = id.split('/').slice(-1)[0]
    return {
      id,
      name,
      description: `${name} does something`,
      group: '',
      files: [{ path: 'SKILL.md', size: 1200, blobSha: '', isEntry: true }],
      allowedTools: [],
      hasExecutables: false,
      ...over,
    }
  }

  function scanOf(skills: ScannedSkill[], over: Partial<ScanResult> = {}): ScanResult {
    return {
      skills,
      groups: [],
      groupingSignal: 'none',
      fileCount: skills.reduce((total, entry) => total + entry.files.length, 0),
      commitSha: 'b81f77abcdef0123',
      ...over,
    }
  }

  function source(over: Partial<SkillSource> = {}): SkillSource {
    return {
      id: 'github:owner/repo',
      kind: 'github',
      name: 'repo',
      repo: 'owner/repo',
      monogram: 'RE',
      blurb: 'Skills from owner/repo.',
      commitSha: 'b81f77abcdef0123',
      scannedAt: '2026-07-28T10:00:00Z',
      ...over,
    }
  }

  run('group labels read as words', () => {
    assert.equal(skillGroupLabel('social-listening'), 'Social listening')
    assert.equal(skillGroupLabel('Document skills'), 'Document skills')
    assert.equal(skillGroupLabel('(repo root)'), '(repo root)')
    assert.equal(skillGroupLabel('in-progress'), 'In progress')
  })

  // ── Installing ───────────────────────────────────────────────────────────────

  run('Install never waits on a folder: it installs for every project', () => {
    const nothingPicked = deriveInstallAvailability(0)
    assert.equal(nothingPicked.enabled, false)
    assert.equal(nothingPicked.reason, null)
    assert.deepEqual(deriveInstallAvailability(2), { enabled: true, reason: null })
  })

  run('a batch install reports what actually happened, failures named', () => {
    assert.equal(summarizeInstallRun(3, []), 'Installed 3 skills.')
    assert.equal(summarizeInstallRun(1, []), 'Installed 1 skill.')
    assert.match(summarizeInstallRun(2, [{ skillId: 'skills/a/tdd', message: 'rate limited' }]), /Installed 2 of 3/)
    assert.match(
      summarizeInstallRun(0, [{ skillId: 'skills/a/tdd', message: 'rate limited' }]),
      /^tdd did not install: rate limited$/,
    )
  })

  // ── Syncing ──────────────────────────────────────────────────────────────────

  run('a sync reports counts, and only counts', () => {
    assert.equal(summarizeSyncRun({ added: 3, removed: 0, refreshed: 0, failures: [] }), 'Synced · 3 new skills')
    assert.equal(summarizeSyncRun({ added: 1, removed: 0, refreshed: 0, failures: [] }), 'Synced · 1 new skill')
    // A sync that brought nothing in says so, rather than reading as an outcome
    // it did not have.
    assert.equal(summarizeSyncRun({ added: 0, removed: 0, refreshed: 0, failures: [] }), 'Synced · no new skills')
    assert.equal(
      summarizeSyncRun({ added: 2, removed: 1, refreshed: 4, failures: [] }),
      'Synced · 2 new skills · 1 removed upstream · 4 installed skills updated',
    )
  })

  run('a sync that could not update an installed skill names it', () => {
    const line = summarizeSyncRun({
      added: 0,
      removed: 0,
      refreshed: 1,
      failures: [{ skillId: 'skills/engineering/tdd', message: 'GitHub rate-limited this request.' }],
    })
    assert.match(line, /tdd did not update: GitHub rate-limited this request\.$/)
  })

  run('the source links out to the history that says what changed', () => {
    assert.equal(skillSourceCommitsUrl(source()), 'https://github.com/owner/repo/commits/b81f77abcdef0123')
    // Nothing to link to for a source that is not a repository.
    assert.equal(skillSourceCommitsUrl(source({ id: 'local:/skills', kind: 'local', repo: '', path: '/skills' })), null)
  })

  run('a listing that came out of the build says so; one read from the repository does not', () => {
    // The two look identical on screen and are different claims about how current
    // the list is (studio-marketplace ruling, 2026-09-06): our own marketplace
    // falls back to the copy this build shipped when the network is not there,
    // and someone deciding whether a plugin exists yet needs to know which
    // question their answer came from.
    assert.equal(bundledScanLine(null), null, 'a scan that has not landed claims nothing either way')
    assert.equal(bundledScanLine({}), null, 'nor does a scan cached before the flag existed')
    assert.equal(bundledScanLine({ bundled: false }), null, 'a read of the repository is the ordinary case')
    assert.match(bundledScanLine({ bundled: true }) ?? '', /bundled copy/)
    assert.match(bundledScanLine({ bundled: true }) ?? '', /repository could not be read/)
    assert.equal(
      /network/.test(bundledScanLine({ bundled: true }) ?? ''),
      false,
      'and never names a cause it does not know: the fallback also fires on a rate limit',
    )
  })

  run('file sizes read in the units of the file', () => {
    assert.equal(formatSkillFileSize(0), '0 B')
    assert.equal(formatSkillFileSize(900), '900 B')
    assert.equal(formatSkillFileSize(2048), '2.0 KB')
    assert.equal(formatSkillFileSize(5 * 1024 * 1024), '5.0 MB')
  })

  // ── The reader ───────────────────────────────────────────────────────────────

  function file(path: string, over: Partial<SkillFileRef> = {}): SkillFileRef {
    return { path, size: 1200, blobSha: '', isEntry: path === 'SKILL.md', ...over }
  }

  run('a skill is read entry first, then its own documents, then its subdirectories', () => {
    const ordered = orderSkillFiles([
      file('scripts/block-dangerous-git.sh'),
      file('UI.md'),
      file('SKILL.md'),
      file('agents/openai.yaml'),
      file('LOGIC.md'),
    ]).map((entry) => entry.path)
    assert.deepEqual(ordered, ['SKILL.md', 'LOGIC.md', 'UI.md', 'agents/openai.yaml', 'scripts/block-dangerous-git.sh'])
    assert.equal(defaultSkillFilePath([file('UI.md'), file('SKILL.md')]), 'SKILL.md')
    // A skill whose scan carried no entry still opens on something readable.
    assert.equal(defaultSkillFilePath([file('UI.md'), file('LOGIC.md')]), 'LOGIC.md')
    assert.equal(defaultSkillFilePath([]), '')
  })

  run('a relative link resolves against the skill it came from', () => {
    const files = [file('SKILL.md'), file('LOGIC.md'), file('UI.md'), file('scripts/run.sh')]
    assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'LOGIC.md'), { kind: 'file', path: 'LOGIC.md' })
    assert.deepEqual(resolveSkillLink(files, 'SKILL.md', './UI.md'), { kind: 'file', path: 'UI.md' })
    // Back the other way, and out of a subdirectory.
    assert.deepEqual(resolveSkillLink(files, 'UI.md', 'SKILL.md'), { kind: 'file', path: 'SKILL.md' })
    assert.deepEqual(resolveSkillLink(files, 'scripts/run.sh', '../SKILL.md'), {
      kind: 'file',
      path: 'SKILL.md',
    })
    assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'scripts/run.sh'), {
      kind: 'file',
      path: 'scripts/run.sh',
    })
    // A fragment on a resolvable file still opens the file.
    assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'LOGIC.md#state'), {
      kind: 'file',
      path: 'LOGIC.md',
    })
  })

  run('a link to a file the scan never carried is dead, and says which file', () => {
    const files = [file('SKILL.md')]
    assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'LOGIC.md'), { kind: 'dead', target: 'LOGIC.md' })
    assert.equal(describeDeadSkillLink('LOGIC.md'), "LOGIC.md is not one of this skill's files.")
  })

  run('anything carrying a scheme is not the skill’s to resolve', () => {
    const files = [file('SKILL.md'), file('LOGIC.md')]
    // Handed back to the renderer's protocol guard: https opens, javascript dies
    // there. Resolving either one here would route it around that guard.
    assert.equal(resolveSkillLink(files, 'SKILL.md', 'https://example.com/LOGIC.md'), null)
    assert.equal(resolveSkillLink(files, 'SKILL.md', 'javascript:steal()'), null)
    assert.equal(resolveSkillLink(files, 'SKILL.md', 'JavaScript:steal()'), null)
    assert.equal(resolveSkillLink(files, 'SKILL.md', 'mailto:matt@example.com'), null)
    assert.equal(resolveSkillLink(files, 'SKILL.md', '#a-heading'), null)
    assert.equal(resolveSkillLink(files, 'SKILL.md', '   '), null)
  })

  run('frontmatter is the briefing, so the document starts after it', () => {
    const withMeta = '---\nname: tdd\ndescription: Write the test first\n---\n\n# TDD\n\nBody.\n'
    assert.equal(stripSkillFrontmatter(withMeta), '\n# TDD\n\nBody.\n')
    // A rule that is not frontmatter is left exactly where the author put it.
    assert.equal(stripSkillFrontmatter('# TDD\n\n---\n\nBody.\n'), '# TDD\n\n---\n\nBody.\n')
    assert.equal(isMarkdownSkillFile('SKILL.md'), true)
    assert.equal(isMarkdownSkillFile('agents/openai.yaml'), false)
    assert.equal(isMarkdownSkillFile('scripts/block-dangerous-git.sh'), false)
  })

  // ── Discover ─────────────────────────────────────────────────────────────────
  // The input discipline GitHub's ten-searches-a-minute budget forces, and the
  // facts a result row is allowed to state.

  /** A clock the test drives, so the quiet window is crossed without waiting. */
  function fakeClock(): {
    schedule: (callback: () => void, delayMs: number) => number
    cancelScheduled: (handle: number) => void
    fire: () => void
    armed: () => number
    delays: number[]
  } {
    const pending = new Map<number, () => void>()
    const delays: number[] = []
    let nextHandle = 1
    return {
      schedule(callback, delayMs) {
        delays.push(delayMs)
        const handle = nextHandle
        nextHandle += 1
        pending.set(handle, callback)
        return handle
      },
      cancelScheduled(handle) {
        pending.delete(handle)
      },
      fire() {
        const due = [...pending.values()]
        pending.clear()
        for (const callback of due) callback()
      },
      armed: () => pending.size,
      delays,
    }
  }

  run('nothing is searched under three characters, and a burst of keystrokes is one request', () => {
    const clock = fakeClock()
    const sent: string[] = []
    const scheduler = createSkillSearchScheduler({
      onSearch: (query) => sent.push(query),
      schedule: clock.schedule,
      cancelScheduled: clock.cancelScheduled,
    })

    assert.deepEqual(scheduler.type(''), { kind: 'empty' })
    assert.deepEqual(scheduler.type('p'), { kind: 'too_short', minLength: 3 })
    assert.deepEqual(scheduler.type('pd'), { kind: 'too_short', minLength: 3 })
    assert.equal(clock.armed(), 0, 'nothing is even armed below the minimum')
    clock.fire()
    assert.deepEqual(sent, [], 'and so nothing is sent')

    // Typing "pdf extract" one key at a time: each keystroke disarms the last, so
    // the quiet window at the end of it spends ONE of the ten requests a minute.
    for (const keystroke of ['pdf', 'pdf ', 'pdf e', 'pdf ex', 'pdf extract']) {
      assert.deepEqual(scheduler.type(keystroke), { kind: 'pending' })
    }
    assert.equal(clock.armed(), 1, 'one armed request, not five')
    clock.fire()
    assert.deepEqual(sent, ['pdf extract'], 'and it carries the last thing typed')
    assert.deepEqual(new Set(clock.delays), new Set([SKILL_SEARCH_DEBOUNCE_MS]))
  })

  run('an armed search does not survive deleting back past the minimum, or leaving', () => {
    const clock = fakeClock()
    const sent: string[] = []
    const scheduler = createSkillSearchScheduler({
      onSearch: (query) => sent.push(query),
      schedule: clock.schedule,
      cancelScheduled: clock.cancelScheduled,
    })

    scheduler.type('pdf')
    assert.deepEqual(scheduler.type('pd'), { kind: 'too_short', minLength: 3 })
    clock.fire()
    assert.deepEqual(sent, [], 'the request armed at three characters was dropped')

    scheduler.type('pdf extract')
    scheduler.cancel()
    clock.fire()
    assert.deepEqual(sent, [], 'and leaving the tab drops it too')

    // Surrounding and repeated whitespace is not a different query.
    scheduler.type('  pdf   extract  ')
    clock.fire()
    assert.deepEqual(sent, ['pdf extract'])
  })

  run('the budget is spoken only when it is about to bite', () => {
    assert.equal(describeSearchBudget(null), null)
    assert.equal(describeSearchBudget({ limit: 10, remaining: 8, resetAt: '' }), null)
    assert.equal(describeSearchBudget({ limit: 10, remaining: 2, resetAt: '' }), '2 searches left this minute.')
    assert.equal(describeSearchBudget({ limit: 10, remaining: 1, resetAt: '' }), '1 search left this minute.')
    assert.equal(describeSearchBudget({ limit: 10, remaining: 0, resetAt: '' }), 'No searches left in this minute.')
  })

  run('a missing token is a failure of the tab; everything else is degraded', () => {
    const condition = (reason: SkillDiscoveryCondition['reason']): SkillDiscoveryCondition => ({
      reason,
      message: reason,
      retryAfterSeconds: 0,
    })
    assert.equal(discoverNoticeTone(condition('needs_token')), 'error')
    assert.equal(discoverNoticeTone(condition('rate_limited')), 'warn')
    assert.equal(discoverNoticeTone(condition('unavailable')), 'warn')
  })

  run('star counts fold, and a repository already added is recognised whatever its case', () => {
    assert.equal(formatStars(0), '0')
    assert.equal(formatStars(973), '973')
    assert.equal(formatStars(4900), '4.9k')
    assert.equal(formatStars(52341), '52k')
    assert.equal(formatStars(999.6), '1k')
    assert.equal(formatStars(1000), '1k')
    assert.equal(formatStars(9960), '10k')
    assert.equal(formatStars(999_600), '1M')
    assert.equal(formatStars(1_240_000), '1.2M')

    const added = addedRepoKeys(['browser-act/skills', '', 'MattPocock/Skills '])
    assert.equal(isRepoAdded(added, 'Browser-Act/Skills'), true)
    assert.equal(isRepoAdded(added, 'mattpocock/skills'), true)
    assert.equal(isRepoAdded(added, 'anthropics/skills'), false)
  })

  run('a skill whose name is not its directory name carries the warning on its row', () => {
    // anthropics/skills' own `template/` declares `template-skill`; the row says
    // so and stays a row, because a source we do not own is not ours to refuse.
    const groups = deriveSkillCatalogueGroups({
      scan: scanOf([skill('template', { name: 'template-skill' }), skill('skills/tdd')]),
      installedDirNames: new Set<string>(),
      query: '',
    })
    const items = groups.flatMap((group) => group.items)
    assert.equal(items.length, 2, 'a name the specification would reject is never a missing row')
    const template = items.find((item) => item.skillId === 'template')
    assert.match(template?.nameWarning ?? '', /is not its directory name “template”/)
    assert.equal(items.find((item) => item.skillId === 'skills/tdd')?.nameWarning, '')
  })

  run('the skills a manifest does not list are grouped, not dropped', () => {
    // The scan puts them in a group of their own, which the catalogue renders
    // like any other — the fallback heading is for a group the scan never named.
    const sections = deriveSkillCatalogueGroups({
      scan: scanOf(
        [skill('skills/pdf', { group: 'document-skills' }), skill('template', { group: 'Everything else' })],
        {
          groups: ['document-skills', 'Everything else'],
          groupingSignal: 'manifest',
        },
      ),
      installedDirNames: new Set<string>(),
      query: '',
    })
    assert.deepEqual(
      sections.map((section) => [section.label, section.items.map((item) => item.skillId)]),
      [
        ['Document skills', ['skills/pdf']],
        ['Everything else', ['template']],
      ],
    )
  })

  run('the reader drops a byte-order mark before the fence, so frontmatter is never prose', () => {
    const withBom = '\uFEFF---\nname: tdd\ndescription: A skill.\n---\n\n# TDD\n\nBody.\n'
    assert.equal(stripSkillFrontmatter(withBom), '\n# TDD\n\nBody.\n')
  })

  console.log('skills surface model tests passed')

  // ── The plugin a skill ships inside ──────────────────────────────────────────
  // A marketplace lays a plugin's skills out as `<plugin>/skills/<skill>`, and
  // the official one carries three skills called "access" that way. The row
  // says which plugin, but only when it tells rows apart.
  {
    assert.equal(skillPluginFolder('external_plugins/discord/skills/access'), 'discord')
    assert.equal(skillPluginFolder('plugins/cwc-makers/skills/m5-onboard'), 'cwc-makers')
    assert.equal(skillPluginFolder('skills/tdd'), '', 'a top-level skills folder has no plugin above it')
    assert.equal(skillPluginFolder('tdd'), '')
    assert.equal(skillPluginFolder('skills/tdd/skills'), '', 'the skill has to be the leaf')
    console.log('ok - skillPluginFolder reads the plugin off the path')
  }
})
