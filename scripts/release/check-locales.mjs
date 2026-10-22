// Fail a package that ships Chromium locales other than the ones Studio keeps.
//
// Chromium's own strings (context menus, dialogs, spellcheck) and the locale
// it reports come one file per language: an .lproj folder each in
// Electron Framework.framework on macOS, plus FEMININE, MASCULINE and NEUTER
// variants of each, and a locales/*.pak each on Windows and Linux. Electron
// ships 55 of them, 49 MB of every macOS app. `build.electronLanguages` in
// package.json keeps ten widely used languages and electron-builder deletes
// the rest as it packages. It cannot carry a comment there, so the reasons are
// here:
//
// - Not English alone. With no file for the system language, Chromium falls
//   back to en-US: app.getLocale(), navigator.language and the default Intl
//   locale all become en-US, and dates and numbers turn US-style (a German
//   system shows m/d/yyyy instead of dd.mm.yyyy). Tested with stock Electron
//   44.7.2. The ten languages kept keep their own formats.
// - The languages: English, German, French, Spanish, Portuguese, Japanese,
//   Chinese, Korean, Italian and Russian. electron-builder 26.17 matches each
//   entry case-insensitively, `_` and `-` alike, and keeps its regional files
//   too: `en` keeps en-US and en-GB, `es` es-419, `pt` pt-BR and pt-PT, and
//   `zh` zh-CN and zh-TW. Any other system language gets en-US as above.
// - The same rule prunes the app's own Contents/Resources/*.lproj on macOS.
//   Electron's are empty folders and Studio adds none.
//
// Two checks, next to every app.asar the package step leaves under dist/:
//
// - Every locale shipped is one of KEPT_LOCALES. A dropped setting, or a mac,
//   win or linux electronLanguages (which replaces the top-level list rather
//   than adding to it), would otherwise ship all 55 again, green.
// - Every one of KEPT_LOCALES is there. A misspelled entry, or a matching rule
//   that changes in an electron-builder upgrade, would otherwise quietly drop
//   a language, en-US included.
//
// KEPT_LOCALES names the files that result, Chromium's names for them;
// check-locales.test.mjs applies electron-builder's rule to package.json's list
// and checks that the two agree.
//
//   node scripts/release/check-locales.mjs [dist]

import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAsars } from './check-app-asar.mjs'

export const KEPT_LOCALES = [
  'en-US',
  'en-GB',
  'de',
  'fr',
  'es',
  'es-419',
  'pt-BR',
  'pt-PT',
  'ja',
  'zh-CN',
  'zh-TW',
  'ko',
  'it',
  'ru',
]

const GRAMMATICAL_GENDER = /-(feminine|masculine|neuter)$/u

/**
 * The locale a Chromium locale file is for, lower case with `-`: `en_GB_FEMININE.lproj` is en-gb, `pt-BR.pak` pt-br.
 * macOS names US English plain `en.lproj`; that is en-us like Windows' and Linux's `en-US.pak`.
 */
export function localeOf(fileName) {
  const locale = fileName
    .replace(/\.(lproj|pak)$/u, '')
    .toLowerCase()
    .replace(/_/gu, '-')
    .replace(GRAMMATICAL_GENDER, '')
  return locale === 'en' ? 'en-us' : locale
}

/**
 * Where an app's locales are, from where its app.asar is: on macOS the framework's Resources (Chromium's) and
 * the app's own Resources (which electron-builder prunes by the same list), elsewhere locales/ beside resources/.
 * `required` is false for the folder Studio's locales do not have to be in.
 */
export function localeDirs(asarPath) {
  const resources = dirname(asarPath)
  if (resources.endsWith(`.app${sep}Contents${sep}Resources`)) {
    const contents = dirname(resources)
    return [
      {
        dir: join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'),
        extension: '.lproj',
        required: true,
      },
      { dir: resources, extension: '.lproj', required: false },
    ]
  }
  return [{ dir: join(dirname(resources), 'locales'), extension: '.pak', required: true }]
}

/** The locale files in a folder, by name; null when the folder is not there. */
export function listLocaleFiles(dir, extension) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(extension))
      .sort()
  } catch {
    return null
  }
}

/** What is wrong with one folder's locale files, as sentences; empty when it passes. */
export function checkLocaleFiles(files, { required = true, kept = KEPT_LOCALES } = {}) {
  if (files === null || files.length === 0) {
    return required
      ? ['no Chromium locale files found; the app layout changed, so this check can no longer see them.']
      : []
  }
  const keptLower = new Map(kept.map((locale) => [locale.toLowerCase(), locale]))
  const problems = []
  const unexpected = files.filter((file) => !keptLower.has(localeOf(file)))
  if (unexpected.length > 0) {
    const locales = [...new Set(unexpected.map(localeOf))]
    problems.push(
      `${locales.length} locale(s) outside KEPT_LOCALES, in ${unexpected.length} file(s): ${locales.join(', ')}. ` +
        "Check package.json's build.electronLanguages; to keep a new language, add it there and to KEPT_LOCALES.",
    )
  }
  if (required) {
    const present = new Set(files.map(localeOf))
    const missing = kept.filter((locale) => !present.has(locale.toLowerCase()))
    if (missing.length > 0) {
      problems.push(
        `${missing.length} kept locale(s) missing: ${missing.join(', ')}. ` +
          "electronLanguages matched fewer files than it did; check electron-builder's matching rule.",
      )
    }
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? 'dist')
  const archives = findAsars(dist)
  if (archives.length === 0) {
    process.stderr.write(`No app.asar under ${dist}; run electron-builder first.\n`)
    process.exit(1)
  }
  const shown = (path) => {
    const fromHere = relative(process.cwd(), path)
    return fromHere && !fromHere.startsWith('..') ? fromHere : path
  }
  let failed = false
  for (const archive of archives) {
    for (const { dir, extension, required } of localeDirs(archive)) {
      const files = listLocaleFiles(dir, extension)
      const problems = checkLocaleFiles(files, { required })
      if (problems.length > 0) {
        failed = true
        for (const problem of problems) process.stderr.write(`${shown(dir)}: ${problem}\n`)
      } else if (files !== null && files.length > 0) {
        const bytes = files.reduce((total, file) => total + sizeOf(join(dir, file)), 0)
        const locales = new Set(files.map(localeOf)).size
        process.stdout.write(
          `${shown(dir)}: ${files.length} ${extension} (${locales} locales, ${(bytes / 1e6).toFixed(1)} MB), all kept.\n`,
        )
      }
    }
  }
  process.exit(failed ? 1 : 0)
}

function sizeOf(path) {
  const stats = statSync(path)
  if (!stats.isDirectory()) return stats.size
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0)
}
