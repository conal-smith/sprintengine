import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDesignSystemBundle } from './bundle-read'
import { test } from 'vitest'

test('bundle-read', async () => {
  // The Design door's reader (item 2002). Two contracts matter here:
  //
  //  1. Every way a folder can fail is its OWN typed reason carrying the path — a
  //     folder we cannot read must never look like a system with no components.
  //  2. The accent is resolved from `foundations/tokens.tokens.json`, the declared
  //     source of truth, NOT the generated `foundations/tokens.css`. The door never
  //     regenerates, so reading the generated file would draw stale values and the
  //     staleness would look like ours.

  const tests: Array<{ name: string; body: () => Promise<void> }> = []
  function run(name: string, body: () => Promise<void>): void {
    tests.push({ name, body })
  }

  const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')

  function exampleCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ds-read-'))
    cpSync(exampleRoot, dir, { recursive: true })
    return dir
  }

  function editTokens(bundleDir: string, mutate: (tokens: Record<string, any>) => void): void {
    const path = join(bundleDir, 'foundations', 'tokens.tokens.json')
    const tokens = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
    mutate(tokens)
    writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`)
  }

  run('a real bundle reads its identity and its accent, per mode', async () => {
    const dir = exampleCopy()
    try {
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      const { identity, manifest } = result.view
      assert.equal(identity.path, dir)
      assert.equal(identity.name, manifest.name)
      assert.equal(identity.version, manifest.version)
      // The example declares a mode-varying accent, so light and dark differ and
      // both are real colours rather than the unresolved `{ref.…}` alias text.
      assert.ok(identity.accent.light?.startsWith('#'), `light: ${identity.accent.light}`)
      assert.ok(identity.accent.dark?.startsWith('#'), `dark: ${identity.accent.dark}`)
      assert.notEqual(identity.accent.light, identity.accent.dark)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('the accent comes from the token SOURCE, not the generated tokens.css', async () => {
    const dir = exampleCopy()
    try {
      const before = await readDesignSystemBundle(dir)
      assert.equal(before.ok, true)
      if (!before.ok) return

      // Author edits the source and does NOT regenerate — exactly the drift the
      // door must not inherit. tokens.css keeps the old value on disk.
      editTokens(dir, (tokens) => {
        tokens.ref.color.green['600'].$value = '#123456'
      })
      const cssPath = join(dir, 'foundations', 'tokens.css')
      const css = readFileSync(cssPath, 'utf8')
      assert.ok(!css.includes('#123456'), 'the generated file is deliberately left stale')

      const after = await readDesignSystemBundle(dir)
      assert.equal(after.ok, true)
      if (!after.ok) return
      assert.equal(after.view.identity.accent.light, '#123456', 'read from the source of truth')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('a bundle with no token file still reads — it just has no accent', async () => {
    const dir = exampleCopy()
    try {
      rmSync(join(dir, 'foundations', 'tokens.tokens.json'), { force: true })
      const result = await readDesignSystemBundle(dir)
      // Mid-authoring is not broken: a manifest without tokens yet is a system
      // with nothing to paint the chip, not a system that failed to load.
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      assert.deepEqual(result.view.identity.accent, { light: null, dark: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('an unresolvable or non-colour accent is null, never the raw alias text', async () => {
    const dir = exampleCopy()
    try {
      editTokens(dir, (tokens) => {
        tokens.sem.color.accent.primary.$value = '{ref.color.green.nope}'
        tokens.sem.color.accent.primary.$extensions['com.sprintengine'].modes = {
          light: '{ref.color.green.nope}',
          dark: '{ref.color.green.nope}',
        }
      })
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(result.view.identity.accent, { light: null, dark: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('a token alias cycle terminates instead of hanging', async () => {
    const dir = exampleCopy()
    try {
      editTokens(dir, (tokens) => {
        tokens.ref.color.green['600'].$value = '{ref.color.green.500}'
        tokens.ref.color.green['500'].$value = '{ref.color.green.600}'
      })
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.view.identity.accent.light, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('each way a folder can fail is its own typed reason, carrying the path', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ds-read-fail-'))
    try {
      const gone = join(parent, 'not-there')
      const missing = await readDesignSystemBundle(gone)
      assert.equal(missing.ok, false)
      if (!missing.ok) {
        assert.equal(missing.reason, 'missing')
        assert.equal(missing.path, gone)
      }

      const empty = join(parent, 'empty')
      mkdirSync(empty)
      const noManifest = await readDesignSystemBundle(empty)
      assert.equal(noManifest.ok, false)
      if (!noManifest.ok) assert.equal(noManifest.reason, 'no-manifest')

      const broken = join(parent, 'broken')
      mkdirSync(broken)
      writeFileSync(join(broken, 'design-system.json'), '{ not json')
      const invalid = await readDesignSystemBundle(broken)
      assert.equal(invalid.ok, false)
      if (!invalid.ok) {
        assert.equal(invalid.reason, 'invalid-manifest')
        assert.equal(invalid.path, broken)
      }

      // A file where a directory should be is "missing", not a crash.
      const notADir = join(parent, 'a-file')
      writeFileSync(notADir, 'x')
      const fileResult = await readDesignSystemBundle(notADir)
      assert.equal(fileResult.ok, false)
      if (!fileResult.ok) assert.equal(fileResult.reason, 'missing')

      const blank = await readDesignSystemBundle('')
      assert.equal(blank.ok, false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  run('an unreadable manifest is unreadable, not "no manifest"', async () => {
    // Permission denied and absence are different problems with different fixes,
    // so they must not collapse into one row state. Skipped as root, where the
    // mode bits do not deny.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('  (skipped: running as root, chmod does not deny)')
      return
    }
    const dir = exampleCopy()
    const manifestPath = join(dir, 'design-system.json')
    try {
      chmodSync(manifestPath, 0o000)
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.reason, 'unreadable')
        assert.equal(result.path, dir)
      }
    } finally {
      chmodSync(manifestPath, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('the full view: specimen, manifest-ordered groups, real component previews', async () => {
    const dir = exampleCopy()
    try {
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      const { view } = result

      // Specimen: emitted from the SOURCE, with the bundle's own palette.
      assert.match(view.specimen.tokensCss, /^\/\* GENERATED FILE/, 'the emitted block')
      assert.ok(view.specimen.ramp.length > 0, 'a colour ramp')
      for (const swatch of view.specimen.ramp) {
        assert.ok(swatch.light.startsWith('#') || swatch.light.startsWith('rgb'), swatch.light)
      }

      // Groups mirror the manifest, in manifest order, and an empty one is absent.
      const declared = Object.entries(view.manifest.contents)
        .filter(([, value]) => Array.isArray(value) && value.length > 0)
        .map(([key]) => key)
      assert.deepEqual(
        view.groups.map((group) => group.key),
        declared,
      )
      for (const group of view.groups) {
        assert.equal(group.count, group.entries.length)
        assert.ok(!/^[A-Z ]+$/.test(group.label), `sentence case, not shouting: ${group.label}`)
      }

      // Components render their REAL markup — not a placeholder, not an icon.
      assert.ok(view.components.length > 0, 'the example ships components')
      for (const component of view.components) {
        assert.ok(component.stages.length > 0, `${component.name} has at least one stage`)
        assert.ok(
          component.stages.some((stage) => stage.html.includes('<')),
          `${component.name} carries real markup`,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('the token families the door draws are resolved by the reader, never re-parsed', async () => {
    const dir = exampleCopy()
    try {
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      const { tokens } = result.view.specimen

      // The Colour / Type / Spacing tabs draw these. They must arrive RESOLVED:
      // the example declares its spacing entirely in `{ref.space.N}` aliases, and
      // a door handed the alias text would draw a square `{ref.space.2}` wide.
      assert.ok(tokens.space.length > 0, 'the example declares a space scale')
      for (const token of tokens.space) {
        assert.match(token.path, /^sem\.space\./, 'the path is the only string the tab prints')
        assert.ok(!token.light.includes('{'), `unresolved alias: ${token.path} = ${token.light}`)
        assert.match(token.light, /^[\d.]+(px|rem|em)$/, token.light)
        // No dark override for a length: both modes carry the same value rather
        // than one of them being empty.
        assert.equal(token.dark, token.light)
      }
      assert.ok(tokens.radius.length > 0, 'and a radius ramp')
      assert.ok(tokens.fontSize.length > 0, 'and a type scale')
      for (const token of tokens.fontSize) assert.match(token.path, /^sem\.font\.size\./)
      assert.ok(tokens.fontWeight.length > 0)

      // A family the bundle does not declare is EMPTY, not absent and not
      // fabricated — the door then draws no section for it.
      assert.deepEqual(tokens.shadow, [], 'the example ships no elevation ramp')
      assert.deepEqual(tokens.size, [], 'nor a control-height ramp')
      assert.deepEqual(tokens.fontTracking, [])

      // Group metadata is not a token: a `$description` beside the steps must not
      // arrive as a row with a path of `sem.space.$description`.
      for (const family of Object.values(tokens)) {
        for (const token of family) assert.ok(!token.path.includes('$'), token.path)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('a token value that is not drawable is refused rather than passed through', async () => {
    const dir = exampleCopy()
    try {
      // Token documents are third-party content, and these values end up in a
      // style attribute. Anything carrying a fetch or a rule separator is dropped
      // at the reader, so the renderer never has to decide.
      editTokens(dir, (tokens) => {
        tokens.sem.space.hostile = { $type: 'dimension', $value: 'url(http://evil/x.png)' }
        tokens.sem.space.injected = { $type: 'dimension', $value: '10px; background:red' }
        tokens.sem.space.fine = { $type: 'dimension', $value: '11px' }
      })
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      const paths = result.view.specimen.tokens.space.map((token) => token.path)
      assert.ok(!paths.includes('sem.space.hostile'), 'a url() never reaches the renderer')
      assert.ok(!paths.includes('sem.space.injected'), 'nor does a value carrying a separator')
      assert.ok(paths.includes('sem.space.fine'), 'and an ordinary length still does')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('path-form pattern and glyph entries read — the manifest canonical form', async () => {
    const dir = exampleCopy()
    try {
      // The example manifest declares "patterns/sign-in.html" / "glyphs/check.svg"
      // — bundle-relative paths. Joining that form onto the group directory
      // doubled the prefix ("patterns/patterns/…") and every declared entry was
      // silently dropped: a section header with a count and no tiles.
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      assert.equal(result.view.patterns.length, 1, 'the declared pattern is read')
      assert.equal(result.view.patterns[0].name, 'sign-in', 'named by stem, not path')
      assert.ok(result.view.patterns[0].html.includes('<'), 'carries real markup')
      assert.equal(result.view.glyphs.length, 1, 'the declared glyph is read')
      assert.equal(result.view.glyphs[0].name, 'check', 'named by stem, not path')
      assert.ok(result.view.glyphs[0].svg.includes('<svg'), 'carries the SVG source')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('bare-name pattern and glyph entries read too — both declared forms work', async () => {
    const dir = exampleCopy()
    try {
      const manifestPath = join(dir, 'design-system.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
      manifest.contents.patterns = ['sign-in']
      manifest.contents.glyphs = ['check.svg']
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.view.patterns[0]?.name, 'sign-in')
      assert.equal(result.view.glyphs[0]?.name, 'check')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('a group the manifest declares that we did not anticipate still renders', async () => {
    const dir = exampleCopy()
    try {
      const manifestPath = join(dir, 'design-system.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
      manifest.contents.motionRules = ['ease-standard', 'ease-entrance']
      manifest.contents.patterns = []
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      const keys = result.view.groups.map((group) => group.key)
      assert.ok(keys.includes('motionRules'), 'an unanticipated group renders')
      assert.ok(!keys.includes('patterns'), 'and a group declared empty is not drawn')
      const motion = result.view.groups.find((group) => group.key === 'motionRules')
      assert.equal(motion?.count, 2)
      assert.equal(motion?.label, 'MotionRules', 'label derives from the key, not a lookup table')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('a bundle-relative asset is inlined; one escaping the bundle is refused', async () => {
    const dir = exampleCopy()
    try {
      const componentDir = join(dir, 'components', 'button')
      writeFileSync(join(componentDir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      writeFileSync(
        join(componentDir, 'component.css'),
        '.a{background:url("mark.svg")}.b{background:url("../../../../etc/passwd")}' +
          '.c{background:url("http://evil/x.png")}',
      )
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      const button = result.view.components.find((component) => component.name === 'button')
      assert.ok(button)
      assert.match(button.css, /url\("data:image\/svg\+xml;base64,/, 'the in-bundle asset inlined')
      assert.ok(!button.css.includes('etc/passwd'), 'the escaping ref never became a data URI')
      assert.ok(!button.css.includes('http://evil'), 'and neither did the remote one')
      // Both are REPORTED, so the tile can say something could not be loaded.
      assert.ok(button.unresolvedRefs.length >= 2, button.unresolvedRefs.join(', '))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  if (process.platform !== 'win32')
    run('an asset linked from inside the bundle to outside it is not inlined', async () => {
      const dir = exampleCopy()
      const outside = mkdtempSync(join(tmpdir(), 'ds-read-outside-'))
      try {
        writeFileSync(
          join(outside, 'private.svg'),
          '<svg xmlns="http://www.w3.org/2000/svg"><title>private</title></svg>',
        )
        const componentDir = join(dir, 'components', 'button')
        symlinkSync(join(outside, 'private.svg'), join(componentDir, 'linked.svg'))
        writeFileSync(join(componentDir, 'component.css'), '.a{background:url("linked.svg")}')
        const result = await readDesignSystemBundle(dir)
        assert.equal(result.ok, true)
        if (!result.ok) return
        const button = result.view.components.find((component) => component.name === 'button')
        assert.ok(button)
        assert.ok(!button.css.includes('data:image/svg+xml'), 'the linked file never became a data URI')
        assert.ok(button.unresolvedRefs.includes('linked.svg'), button.unresolvedRefs.join(', '))
      } finally {
        rmSync(dir, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })

  run('a glyph or pattern named by a path that climbs out of the bundle is not read', async () => {
    const dir = exampleCopy()
    const outside = `${dir}-outside`
    try {
      mkdirSync(outside)
      writeFileSync(
        join(outside, 'private.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"><title>private</title></svg>',
      )
      writeFileSync(join(outside, 'private.html'), '<p>private</p>')
      const manifestPath = join(dir, 'design-system.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
      const name = dir.split(/[\\/]/).pop()!
      manifest.contents.glyphs = ['check', `../../${name}-outside/private`]
      manifest.contents.patterns = [`../../${name}-outside/private`]
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(
        result.view.glyphs.map((glyph) => glyph.name),
        ['check'],
      )
      assert.equal(result.view.patterns.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  run('opening a system spawns no process and writes nothing', async () => {
    const dir = exampleCopy()
    try {
      // The read-only contract, asserted two ways. First: the module's CODE (with
      // comments stripped, so prose about not spawning does not trip it) references
      // nothing that can spawn a process or write a file. A future edit that forks
      // a bundle script fails here rather than in production.
      const source = readFileSync(join(process.cwd(), 'src/main/design-system/bundle-read.ts'), 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const forbidden of [
        'child_process',
        'utilityProcess',
        'spawn',
        'execFile',
        'fork(',
        'writeFile',
        'mkdir',
        'rmdir',
        'unlink',
        'rename',
        'appendFile',
      ]) {
        assert.ok(!code.includes(forbidden), `bundle-read must not reference ${forbidden} in code`)
      }
      // And it imports only the read half of fs/promises.
      const fsImport = /import \{([^}]*)\} from 'fs\/promises'/.exec(code)
      assert.ok(fsImport, 'the module imports from fs/promises')
      const imported = fsImport[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
      assert.deepEqual(imported.sort(), ['readFile', 'readdir', 'realpath', 'stat'], 'read-only fs surface')

      // The one module the read path reaches that DOES run a process is
      // `entry-added-at`, and it is held to the other half of the same contract:
      // it may query git, and it may not write. A `git add`, a `git checkout`, or
      // any fs writer appearing there would be this module reaching into the
      // user's own repo on a path that opens every time the door does.
      const addedAtSource = readFileSync(join(process.cwd(), 'src/main/design-system/entry-added-at.ts'), 'utf8')
      const addedAtCode = addedAtSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const forbidden of [
        'writeFile',
        'mkdir',
        'rmdir',
        'unlink',
        'appendFile',
        'utilityProcess',
        'fork(',
        // (`rename` is not in this list: `--no-renames` is a git LOG flag. The
        // fs surface below pins the writers out completely anyway.)
        // git subcommands that would change the user's repo rather than ask it.
        "'add'",
        "'commit'",
        "'checkout'",
        "'clean'",
        "'reset'",
      ]) {
        assert.ok(!addedAtCode.includes(forbidden), `entry-added-at must not reference ${forbidden}`)
      }
      // And it reads exactly one thing from the filesystem.
      const addedAtFsImport = /import \{([^}]*)\} from 'fs\/promises'/.exec(addedAtCode)
      assert.ok(addedAtFsImport, 'entry-added-at imports from fs/promises')
      assert.deepEqual(
        addedAtFsImport[1]
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
          .sort(),
        ['stat'],
        'entry-added-at only stats',
      )

      // Second: nothing on disk changed across a read.
      const before = snapshot(dir)
      await readDesignSystemBundle(dir)
      assert.deepEqual(snapshot(dir), before, 'the bundle folder is byte-identical after a read')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  run('a 100-component bundle reads in one call, and the payload stays linear', async () => {
    // The density acceptance is measured, not assumed. This covers the READ half
    // (one IPC call, payload size); the render half is measured in the app.
    const dir = exampleCopy()
    try {
      const componentsDir = join(dir, 'components')
      const template = join(componentsDir, 'button')
      const manifestPath = join(dir, 'design-system.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
      const names: string[] = [...manifest.contents.components]
      for (let index = names.length; index < 100; index += 1) {
        const name = `generated-${String(index).padStart(3, '0')}`
        cpSync(template, join(componentsDir, name), { recursive: true })
        names.push(name)
      }
      manifest.contents.components = names
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const started = process.hrtime.bigint()
      const result = await readDesignSystemBundle(dir)
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.view.components.length, 100)

      const bytes = Buffer.byteLength(JSON.stringify(result.view), 'utf8')
      const perComponent = bytes / 100
      console.log(
        `  measured: 100 components read in ${elapsedMs.toFixed(0)}ms, ` +
          `payload ${(bytes / 1024).toFixed(0)}KiB (${perComponent.toFixed(0)}B/component)`,
      )
      // The token block is carried ONCE, not per component — the whole reason the
      // payload is FRAGMENTS rather than composed documents. Composing per
      // component in the reader would repeat it a hundred times; the renderer does
      // that composition instead, per visible tile.
      const serialised = JSON.stringify(result.view)
      const header = '/* GENERATED FILE'
      const occurrences = serialised.split(JSON.stringify(header).slice(1, -1)).length - 1
      assert.equal(occurrences, 1, 'the emitted token block appears exactly once in the payload')
      // And the payload is linear in real authored content, not quadratic.
      assert.ok(perComponent < 40_000, `${perComponent.toFixed(0)}B per component is out of budget`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── When each entry arrived (the Design door's "New" marker) ────────────────
  //
  // The date is DERIVED, from the two places it already exists on disk. Nothing is
  // added to `design-system.json`: a bundle a user authored last year must light
  // its markers without being edited, which a new manifest field could never do.

  /** A temp git repo with the example bundle inside it, committed in stages. */
  function gitRepoWithBundle(): { repo: string; bundleDir: string } {
    const repo = mkdtempSync(join(tmpdir(), 'ds-added-git-'))
    const bundleDir = join(repo, 'design-system')
    cpSync(exampleRoot, bundleDir, { recursive: true })
    git(repo, 'init', '-b', 'main')
    return { repo, bundleDir }
  }

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    })
  }

  function commitAt(repo: string, when: string, message: string): void {
    git(repo, 'add', '-A')
    execFileSync('git', ['-C', repo, 'commit', '-m', message], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      },
    })
  }

  function declareComponent(bundleDir: string, name: string): void {
    const manifestPath = join(bundleDir, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
    cpSync(join(bundleDir, 'components', 'button'), join(bundleDir, 'components', name), {
      recursive: true,
    })
    manifest.contents.components = [...manifest.contents.components, name]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  run('inside a git repo, each entry is dated by the commit that ADDED it', async () => {
    const { repo, bundleDir } = gitRepoWithBundle()
    try {
      commitAt(repo, '2026-01-05T10:00:00+00:00', 'the system arrives')
      declareComponent(bundleDir, 'late-arrival')
      commitAt(repo, '2026-06-02T09:30:00+00:00', 'one more component')

      const result = await readDesignSystemBundle(bundleDir)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      const addedAt = result.view.addedAt ?? {}

      // Every declared entry got a date from history, keyed by group + the
      // manifest's own string.
      assert.equal(addedAt['components:button'], '2026-01-05T10:00:00.000Z')
      assert.equal(addedAt['components:late-arrival'], '2026-06-02T09:30:00.000Z')
      assert.equal(addedAt['foundations:foundations/tokens.tokens.json'], '2026-01-05T10:00:00.000Z')
      // A component is a DIRECTORY: its date is the earliest add among its files,
      // not whichever file git happened to name first.
      for (const declared of result.view.manifest.contents.components) {
        assert.ok(addedAt[`components:${declared}`], `${declared} has no date`)
      }

      // And the manifest itself is untouched — the schema gains nothing.
      assert.ok(!('addedAt' in result.view.manifest), 'the manifest schema is not extended')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('a component deleted and restored keeps its ORIGINAL arrival', async () => {
    // Otherwise a refactor that moved a component out and back announces it as
    // new to everyone who has been watching it for a year.
    const { repo, bundleDir } = gitRepoWithBundle()
    try {
      commitAt(repo, '2026-01-05T10:00:00+00:00', 'the system arrives')
      const componentDir = join(bundleDir, 'components', 'button')
      const kept = snapshot(componentDir)
      rmSync(componentDir, { recursive: true, force: true })
      commitAt(repo, '2026-03-01T10:00:00+00:00', 'drop it')
      mkdirSync(componentDir, { recursive: true })
      for (const [relative, base64] of Object.entries(kept)) {
        writeFileSync(join(componentDir, relative.replace(/^[\\/]/, '')), Buffer.from(base64, 'base64'))
      }
      commitAt(repo, '2026-07-01T10:00:00+00:00', 'bring it back')

      const result = await readDesignSystemBundle(bundleDir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.view.addedAt?.['components:button'], '2026-01-05T10:00:00.000Z')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('an uncommitted component in a tracked bundle falls back on its own', async () => {
    // A bundle can be in a repo and still hold something never committed. The
    // fallback is per ENTRY, not per bundle, so the new one is not simply dateless.
    const { repo, bundleDir } = gitRepoWithBundle()
    try {
      commitAt(repo, '2026-01-05T10:00:00+00:00', 'the system arrives')
      declareComponent(bundleDir, 'never-committed')

      const result = await readDesignSystemBundle(bundleDir)
      assert.equal(result.ok, true)
      if (!result.ok) return
      const addedAt = result.view.addedAt ?? {}
      assert.equal(addedAt['components:button'], '2026-01-05T10:00:00.000Z')
      const uncommitted = addedAt['components:never-committed']
      // Birthtime, where the filesystem carries one: recent, and never the git date.
      if (uncommitted !== undefined) {
        assert.notEqual(uncommitted, '2026-01-05T10:00:00.000Z')
        assert.ok(Date.now() - Date.parse(uncommitted) < 60 * 60 * 1000, uncommitted)
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  run('a bundle outside git is dated by birthtime, and never fails the read', async () => {
    const dir = exampleCopy()
    try {
      const result = await readDesignSystemBundle(dir)
      assert.equal(result.ok, true, result.ok ? '' : result.message)
      if (!result.ok) return
      const addedAt = result.view.addedAt ?? {}
      // A folder with no repo behind it still reads; it just has no history to
      // ask. Where the filesystem reports a creation time, every declared entry
      // that is actually on disk carries one — and it is the copy's own age.
      for (const [key, iso] of Object.entries(addedAt)) {
        assert.ok(!Number.isNaN(Date.parse(iso)), `${key} is not a date: ${iso}`)
        assert.ok(Date.now() - Date.parse(iso) < 60 * 60 * 1000, `${key} is not recent: ${iso}`)
      }
      // Filesystems that carry no birthtime report nothing rather than the epoch:
      // an unknown date must never render as an ancient one.
      if (Object.keys(addedAt).length > 0) {
        assert.ok(addedAt['components:button'], 'a component on disk is dated')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Every file under a directory, with its bytes — for an unchanged-after check. */
  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else out[full.slice(dir.length)] = readFileSync(full, 'base64')
      }
    }
    walk(dir)
    return out
  }

  async function main(): Promise<void> {
    for (const test of tests) {
      try {
        await test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        console.error(`not ok - ${test.name}`)
        throw error
      }
    }
    console.log('bundle-read.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
