import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { createAgentDownloads, reportedDownloadUrl, safeDownloadName, type AgentDownloadItem } from './agent-downloads'

const DIRECTORY = '/Users/dev/app/.sprintengine/browser/downloads'

function item(filename: string) {
  const done = new EventEmitter()
  const fake = {
    savedTo: null as string | null,
    getFilename: () => filename,
    getURL: () => `https://example.com/files/${filename}`,
    setSavePath(path: string) {
      fake.savedTo = path
    },
    once: (event: 'done', listener: (event: unknown, state: 'completed') => void) => done.once(event, listener),
    finish: () => done.emit('done', {}, 'completed'),
  }
  return fake as typeof fake & AgentDownloadItem
}

test('a suggested name that climbs out of the folder keeps only its file name', () => {
  expect(safeDownloadName('../../etc/passwd')).toBe('passwd')
  expect(safeDownloadName('..\\..\\Windows\\evil.exe')).toBe('evil.exe')
  expect(safeDownloadName('/Users/dev/.ssh/id_ed25519')).toBe('id_ed25519')
  expect(safeDownloadName('..')).toBe('download')
  expect(safeDownloadName('')).toBe('download')
})

test('a suggested name loses what a file system refuses and its leading dots', () => {
  expect(safeDownloadName('re:port<1>?.csv')).toBe('re_port_1__.csv')
  expect(safeDownloadName('line\nbreak.txt')).toBe('line_break.txt')
  expect(safeDownloadName('.bashrc')).toBe('bashrc')
  expect(safeDownloadName('CON.txt')).toBe('_CON.txt')
})

test('a long suggested name is cut, keeping its extension', () => {
  const name = safeDownloadName(`${'a'.repeat(300)}.tar.gz`)
  expect(name.length).toBe(120)
  expect(name.endsWith('a.gz')).toBe(true)
})

test('the agent’s download is saved under its safe name in the folder given', () => {
  const downloads = createAgentDownloads(() => false)
  const download = item('../report.csv')
  expect(downloads.save(download, DIRECTORY)).toBe(join(DIRECTORY, 'report.csv'))
  expect(download.savedTo).toBe(join(DIRECTORY, 'report.csv'))
})

test('two downloads of one name, running together or beside a file already there, each get their own', () => {
  const existing = new Set([join(DIRECTORY, 'report.csv')])
  const downloads = createAgentDownloads((path) => existing.has(path))
  const first = item('report.csv')
  const second = item('report.csv')
  expect(downloads.save(first, DIRECTORY)).toBe(join(DIRECTORY, 'report (1).csv'))
  expect(downloads.save(second, DIRECTORY)).toBe(join(DIRECTORY, 'report (2).csv'))
})

test('a finished download gives its name back to the next one when no file took it', () => {
  const downloads = createAgentDownloads(() => false)
  const first = item('report.csv')
  downloads.save(first, DIRECTORY)
  first.finish()
  expect(downloads.save(item('report.csv'), DIRECTORY)).toBe(join(DIRECTORY, 'report.csv'))
})

test('a data: URL is reported by its media type alone', () => {
  expect(reportedDownloadUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png,…')
  expect(reportedDownloadUrl('DATA:,hello')).toBe('data:,…')
  expect(reportedDownloadUrl('data:text/html<script>,x')).toBe('data:text/htmlscript,…')
  expect(reportedDownloadUrl('https://example.com/a.csv')).toBe('https://example.com/a.csv')
})
