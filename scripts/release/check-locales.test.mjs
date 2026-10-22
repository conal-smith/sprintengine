import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPackage } from '@electron/asar'

import { findAsars } from './check-app-asar.mjs'
import { KEPT_LOCALES, checkLocaleFiles, listLocaleFiles, localeDirs, localeOf } from './check-locales.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const electronLanguages = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).build.electronLanguages

// The 55 locales Electron 44.7.2 ships, by their Windows and Linux names.
const CHROMIUM_PAKS = [
  'af', 'am', 'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en-GB', 'en-US', 'es', 'es-419', 'et', 'fa', 'fi',
  'fil', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr', 'ms', 'nb', 'nl',
  'pl', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi', 'zh-CN',
  'zh-TW',
].map((locale) => `${locale}.pak`)

// The same on macOS: `_` for `-`, US English as plain `en`, and three grammatical-gender variants of each.
const CHROMIUM_LPROJS = CHROMIUM_PAKS.flatMap((pak) => {
  const name = pak.replace(/\.pak$/u, '').replace(/-/gu, '_').replace(/^en_US$/u, 'en')
  return [name, `${name}_FEMININE`, `${name}_MASCULINE`, `${name}_NEUTER`].map((variant) => `${variant}.lproj`)
})

// electron-builder 26.17's rule (removeUnusedLanguagesIfNeeded in app-builder-lib/out/electron/ElectronFramework.js):
// case-insensitive, `_` as `-`, and a file is kept when an entry names it, a region of it, or a language it is a
// region of.
function keptByElectronBuilder(files, wanted) {
  const normalize = (locale) => locale.trim().toLowerCase().replace(/_/gu, '-')
  const languages = wanted.map(normalize)
  return files.filter((file) => {
    const language = normalize(file.replace(/\.(lproj|pak)$/u, ''))
    return languages.some((it) => it === language || language.startsWith(`${it}-`) || it.startsWith(`${language}-`))
  })
}

function sameLocales(files) {
  return [...new Set(files.map(localeOf))].sort()
}

const keptLower = KEPT_LOCALES.map((locale) => locale.toLowerCase()).sort()

test('locale files are read as their locale, whatever the platform calls them', () => {
  assert.equal(localeOf('en.lproj'), 'en-us')
  assert.equal(localeOf('en-US.pak'), 'en-us')
  assert.equal(localeOf('en_GB_FEMININE.lproj'), 'en-gb')
  assert.equal(localeOf('es_419_NEUTER.lproj'), 'es-419')
  assert.equal(localeOf('pt-BR.pak'), 'pt-br')
  assert.equal(localeOf('zh_TW_MASCULINE.lproj'), 'zh-tw')
  assert.equal(localeOf('fil.lproj'), 'fil')
})

test("package.json's electronLanguages keeps exactly KEPT_LOCALES on every platform", () => {
  assert.equal(electronLanguages.length, 10, 'ten languages')
  assert.deepEqual(sameLocales(keptByElectronBuilder(CHROMIUM_PAKS, electronLanguages)), keptLower)
  const lprojs = keptByElectronBuilder(CHROMIUM_LPROJS, electronLanguages)
  assert.deepEqual(sameLocales(lprojs), keptLower)
  // Every variant of a kept locale survives with it.
  assert.equal(lprojs.length, KEPT_LOCALES.length * 4)
})

test('every kept locale is one Electron ships, so none of them is a typo', () => {
  const shipped = new Set(CHROMIUM_PAKS.map(localeOf))
  for (const locale of KEPT_LOCALES) assert.ok(shipped.has(locale.toLowerCase()), locale)
})

test("the installed Electron's locales come out as KEPT_LOCALES", (t) => {
  const dist = join(root, 'node_modules', 'electron', 'dist')
  const found = [
    { dir: join(dist, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'), extension: '.lproj' },
    { dir: join(dist, 'locales'), extension: '.pak' },
  ]
    .map(({ dir, extension }) => listLocaleFiles(dir, extension))
    .find((files) => files !== null && files.length > 0)
  if (!found) {
    t.skip('no Electron download in node_modules')
    return
  }
  const kept = keptByElectronBuilder(found, electronLanguages)
  assert.deepEqual(sameLocales(kept), keptLower)
  assert.deepEqual(checkLocaleFiles(kept), [])
})

test('the kept locales pass, on macOS and on Windows and Linux', () => {
  assert.deepEqual(checkLocaleFiles(keptByElectronBuilder(CHROMIUM_LPROJS, electronLanguages)), [])
  assert.deepEqual(checkLocaleFiles(keptByElectronBuilder(CHROMIUM_PAKS, electronLanguages)), [])
})

test('all 55, as an app packaged without the setting ships them, fail and are named once each', () => {
  const problems = checkLocaleFiles(CHROMIUM_LPROJS)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^41 locale\(s\) outside KEPT_LOCALES, in 164 file\(s\): af, am, ar,/u)
  assert.doesNotMatch(problems[0], /FEMININE|\bde\b|\bja\b/u)
})

test('a kept locale that did not ship fails, en-US included', () => {
  const withoutEnglish = keptByElectronBuilder(CHROMIUM_PAKS, electronLanguages).filter((file) => file !== 'en-US.pak')
  const problems = checkLocaleFiles(withoutEnglish)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^1 kept locale\(s\) missing: en-US\./u)
  assert.match(checkLocaleFiles(['en.lproj', 'de.lproj'])[0], /12 kept locale\(s\) missing: en-GB, fr, es,/u)
})

test("a folder without locales fails where Chromium's should be, and passes where it need not be", () => {
  assert.match(checkLocaleFiles(null)[0], /no Chromium locale files found/u)
  assert.match(checkLocaleFiles([])[0], /no Chromium locale files found/u)
  assert.deepEqual(checkLocaleFiles([], { required: false }), [])
  assert.deepEqual(checkLocaleFiles(null, { required: false }), [])
  // The app's own folder may hold fewer of the kept locales, but none beyond them.
  assert.deepEqual(checkLocaleFiles(['en.lproj'], { required: false }), [])
  assert.match(checkLocaleFiles(['en.lproj', 'nl.lproj'], { required: false })[0], /1 locale\(s\) outside KEPT_LOCALES.*: nl\./u)
})

test("locales are found beside each app's archive, on macOS and on Windows and Linux", () => {
  const mac = join('dist', 'mac-arm64', 'App.app', 'Contents', 'Resources', 'app.asar')
  assert.deepEqual(localeDirs(mac), [
    {
      dir: join('dist', 'mac-arm64', 'App.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'),
      extension: '.lproj',
      required: true,
    },
    { dir: join('dist', 'mac-arm64', 'App.app', 'Contents', 'Resources'), extension: '.lproj', required: false },
  ])
  assert.deepEqual(localeDirs(join('dist', 'win-unpacked', 'resources', 'app.asar')), [
    { dir: join('dist', 'win-unpacked', 'locales'), extension: '.pak', required: true },
  ])
  assert.deepEqual(localeDirs(join('dist', 'linux-unpacked', 'resources', 'app.asar')), [
    { dir: join('dist', 'linux-unpacked', 'locales'), extension: '.pak', required: true },
  ])
})

test('a packaged dist is checked end to end', async () => {
  const source = mkdtempSync(join(tmpdir(), 'check-locales-src-'))
  const dist = mkdtempSync(join(tmpdir(), 'check-locales-dist-'))
  try {
    writeFileSync(join(source, 'package.json'), '{}')
    const contents = join(dist, 'mac-arm64', 'App.app', 'Contents')
    const framework = join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    for (const lproj of keptByElectronBuilder(CHROMIUM_LPROJS, electronLanguages)) {
      mkdirSync(join(framework, lproj), { recursive: true })
      writeFileSync(join(framework, lproj, 'locale.pak'), 'x')
    }
    mkdirSync(join(contents, 'Resources', 'en.lproj'), { recursive: true })
    await createPackage(source, join(contents, 'Resources', 'app.asar'))
    const linux = join(dist, 'linux-unpacked')
    mkdirSync(join(linux, 'resources'), { recursive: true })
    await createPackage(source, join(linux, 'resources', 'app.asar'))
    mkdirSync(join(linux, 'locales'))
    for (const pak of CHROMIUM_PAKS) writeFileSync(join(linux, 'locales', pak), 'x')

    const results = findAsars(dist).flatMap((archive) =>
      localeDirs(archive).map(({ dir, extension, required }) => checkLocaleFiles(listLocaleFiles(dir, extension), { required })),
    )
    // Linux's locales/ still holds all 55; the Mac app holds only the kept ones, in both folders.
    assert.equal(results.length, 3)
    assert.equal(results[0].length, 1)
    assert.match(results[0][0], /^41 locale\(s\) outside KEPT_LOCALES/u)
    assert.deepEqual(results.slice(1), [[], []])
    assert.equal(readdirSync(framework).length, KEPT_LOCALES.length * 4)
    assert.ok(existsSync(join(linux, 'locales', 'nl.pak')))
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(dist, { recursive: true, force: true })
  }
})
