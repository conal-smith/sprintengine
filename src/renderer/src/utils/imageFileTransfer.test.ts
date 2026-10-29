import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  pastedImagePaths,
  pathsForPathlessFiles,
  quotePromptPath,
  readPastedImagePaths,
  sortDroppedFiles,
  sortFiles,
  splitShellWords,
} from './imageFileTransfer'

test('a pasted screenshot path is read however it was quoted', () => {
  const path = '/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png'
  assert.deepEqual(pastedImagePaths(`'${path}'`), [path])
  assert.deepEqual(pastedImagePaths(`"${path}"`), [path])
  assert.deepEqual(pastedImagePaths(path.replace(/ /g, '\\ ')), [path])
  assert.deepEqual(pastedImagePaths(`${path}\n`), [path], 'a trailing newline is not part of the path')
  assert.deepEqual(pastedImagePaths(path), [path], 'one path pasted bare keeps its spaces')
})

test('several pasted image paths are each read, in order', () => {
  assert.deepEqual(pastedImagePaths("'/Users/dev/a b.png' /Users/dev/c.JPG\n/Users/dev/d\\ e.webp"), [
    '/Users/dev/a b.png',
    '/Users/dev/c.JPG',
    '/Users/dev/d e.webp',
  ])
  assert.deepEqual(pastedImagePaths('file:///Users/dev/shot%201.gif'), ['/Users/dev/shot 1.gif'])
  assert.deepEqual(pastedImagePaths('C:\\Users\\dev\\Pictures\\shot.png'), ['C:\\Users\\dev\\Pictures\\shot.png'])
  assert.deepEqual(pastedImagePaths('"C:\\Users\\dev\\shot one.png"'), ['C:\\Users\\dev\\shot one.png'])
})

test('a paste that is anything more than image paths stays text', () => {
  for (const text of [
    '',
    'look at /Users/dev/a.png',
    '/Users/dev/notes.txt',
    'relative/shot.png',
    "'/Users/dev/unclosed.png",
    '/Users/dev/a.png and more words',
    '/Users/dev/a.png\n/Users/dev/b.pdf',
    '~/Desktop/shot.png',
    '/Users/dev/compare this with /Users/dev/shot.png',
  ]) {
    assert.equal(pastedImagePaths(text), null, JSON.stringify(text))
  }
})

test('an image inside the project is typed as its path; only one from outside attaches', () => {
  const roots = ['/Users/dev/repo']
  assert.equal(pastedImagePaths('/Users/dev/repo/public/logo.png', roots), null, 'the agent can open it itself')
  assert.equal(pastedImagePaths("'/Users/dev/repo/docs/shot one.png'", roots), null)
  assert.deepEqual(pastedImagePaths('/Users/dev/Downloads/logo.png', roots), ['/Users/dev/Downloads/logo.png'])
  assert.deepEqual(pastedImagePaths('/var/folders/x1/T/shot.png', roots), ['/var/folders/x1/T/shot.png'])
  assert.deepEqual(
    pastedImagePaths('/Users/dev/repository-assets/a.png', roots),
    ['/Users/dev/repository-assets/a.png'],
    'a sibling that shares the prefix is outside',
  )
  assert.equal(
    pastedImagePaths('/Users/dev/Downloads/a.png /Users/dev/repo/b.png', roots),
    null,
    'a paste naming both kinds stays text whole',
  )
  assert.equal(pastedImagePaths('C:\\Users\\dev\\Repo\\shot.png', ['c:/Users/dev/Repo/']), null)
  assert.deepEqual(pastedImagePaths('/Users/dev/repo/a.png', ['']), ['/Users/dev/repo/a.png'], 'no root, no rule')
})

test('a pasted WSL path to a file in a Windows workspace stays text', () => {
  assert.equal(pastedImagePaths('/mnt/c/Users/dev/repo/shot.png', ['C:\\Users\\dev\\repo']), null)
  assert.deepEqual(pastedImagePaths('/mnt/c/Users/dev/other/shot.png', ['C:\\Users\\dev\\repo']), [
    '/mnt/c/Users/dev/other/shot.png',
  ])
})

test('words split the way a shell splits them', () => {
  assert.deepEqual(splitShellWords(`a 'b c' "d \\" e" f\\ g`), ['a', 'b c', 'd " e', 'f g'])
  assert.equal(splitShellWords('ends with \\'), null)
})

test('a dropped path is quoted only when it needs it, and reads back as the one path', () => {
  assert.equal(quotePromptPath('/Users/dev/project/src/app.ts'), '/Users/dev/project/src/app.ts')
  assert.equal(quotePromptPath('/Users/dev/Desktop/Q3 budget.xlsx'), "'/Users/dev/Desktop/Q3 budget.xlsx'")
  // An apostrophe would end a single-quoted path, so it is spliced out.
  const apostrophe = "/Users/dev/Desktop/Dev's Files/notes.md"
  assert.equal(quotePromptPath(apostrophe), `'/Users/dev/Desktop/Dev'"'"'s Files/notes.md'`)
  assert.deepEqual(splitShellWords(quotePromptPath(apostrophe)), [apostrophe])
  assert.deepEqual(splitShellWords(quotePromptPath("/Users/dev/it's.md")), ["/Users/dev/it's.md"])
  // A Windows path takes double quotes, which none can contain.
  assert.equal(quotePromptPath("C:\\Users\\dev\\Dev's Files\\a.txt"), `"C:\\Users\\dev\\Dev's Files\\a.txt"`)
  assert.equal(quotePromptPath('\\\\build-box\\share\\My Docs'), '"\\\\build-box\\share\\My Docs"')
})

test('pasted paths are read into image files at paste time, or not at all', async () => {
  const read = async (path: string) => {
    if (path.endsWith('gone.png'))
      throw new Error(
        "Error invoking remote method 'fs:read-image-data-url': Error: ENOENT: no such file or directory, stat",
      )
    return 'data:image/png;base64,iVBORw0K'
  }
  const read1 = await readPastedImagePaths(['/Users/dev/Screenshot one.png'], read)
  assert.equal(read1.ok, true)
  if (read1.ok) {
    assert.equal(read1.files[0]?.name, 'Screenshot one.png')
    assert.equal(read1.files[0]?.type, 'image/png')
    assert.equal(read1.files[0]?.size, 6)
  }
  assert.deepEqual(await readPastedImagePaths(['/Users/dev/a.png', '/Users/dev/gone.png'], read), {
    ok: false,
    message: 'Could not attach gone.png: the file no longer exists.',
  })
})

test('a file with no path is uploaded where the shell can, and refused by name where it cannot', async () => {
  const file = { name: 'report.pdf' } as File
  const withApi = async (api: unknown, run: () => Promise<void>) => {
    const holder = globalThis as { window?: unknown }
    const before = holder.window
    holder.window = { api }
    try {
      await run()
    } finally {
      holder.window = before
    }
  }
  await withApi({ clientCapabilities: ['file-uploads'], uploadFiles: async () => ['/srv/up/report.pdf'] }, async () =>
    assert.deepEqual(await pathsForPathlessFiles([file]), { paths: ['/srv/up/report.pdf'], message: null }),
  )
  await withApi(
    {
      clientCapabilities: ['file-uploads'],
      uploadFiles: async () => {
        throw new Error('That file is over 50 MB, too large to upload.')
      },
    },
    async () =>
      assert.deepEqual(await pathsForPathlessFiles([file]), {
        paths: [],
        message: 'That file is over 50 MB, too large to upload.',
      }),
  )
  // A desktop window has no uploads: the drop is refused as before.
  await withApi({}, async () => {
    const answer = await pathsForPathlessFiles([file])
    assert.deepEqual(answer.paths, [])
    assert.match(answer.message ?? '', /report\.pdf has no path on disk/u)
  })
})

test('a file from the system is attached by path, an image attaches as an image where it can, and a pathless one waits for upload', () => {
  const holder = globalThis as { window?: unknown }
  const before = holder.window
  const attached: string[] = []
  const paths = new Map<unknown, string>()
  holder.window = {
    api: {
      // The path is read through `attachFile`, which is what tells main the
      // person attached it: only such a path opens from its card.
      attachFile: (file: unknown) => {
        const path = paths.get(file) ?? ''
        if (path) attached.push(path)
        return path
      },
      getPathForFile: (file: unknown) => paths.get(file) ?? '',
    },
  }
  try {
    const sheet = { name: 'Q3 budget.xlsx', type: 'application/vnd.ms-excel' } as File
    const shot = { name: 'shot.png', type: 'image/png' } as File
    const web = { name: 'from-a-page.pdf', type: 'application/pdf' } as File
    paths.set(sheet, '/Users/dev/Desktop/Q3 budget.xlsx')
    paths.set(shot, '/Users/dev/Desktop/shot.png')
    assert.deepEqual(sortFiles([sheet, shot, web], { attachImages: true, attachByPath: true }), {
      paths: [],
      files: ['/Users/dev/Desktop/Q3 budget.xlsx'],
      images: [shot],
      pathless: [web],
    })
    // Where the provider reads no images, a picture is a file like any other.
    assert.deepEqual(sortFiles([shot], { attachImages: false, attachByPath: true }), {
      paths: [],
      files: ['/Users/dev/Desktop/shot.png'],
      images: [],
      pathless: [],
    })
    assert.deepEqual(attached, ['/Users/dev/Desktop/Q3 budget.xlsx', '/Users/dev/Desktop/shot.png'])

    // A raw DNG original is a file whatever type it is labelled with: sent as
    // the PNG or JPEG it claims to be, its bytes would not decode.
    const raws = ['image/png', 'image/jpeg', 'image/tiff', ''].map((type) => ({ name: 'photo.DNG', type }) as File)
    raws.forEach((raw) => paths.set(raw, '/Users/dev/Desktop/photo.DNG'))
    assert.deepEqual(sortFiles(raws, { attachImages: true, attachByPath: true }), {
      paths: [],
      files: raws.map(() => '/Users/dev/Desktop/photo.DNG'),
      images: [],
      pathless: [],
    })
    const exported = { name: 'export.dng.png', type: 'image/png' } as File
    assert.deepEqual(sortFiles([exported], { attachImages: true, attachByPath: true }).images, [exported])
    attached.length = 2

    // Where files are typed as paths (a chat on another machine), a file is its
    // typed path, and main is not told about a file no card will show.
    assert.deepEqual(sortFiles([sheet, shot, web], { attachImages: true, attachByPath: false }), {
      paths: ['/Users/dev/Desktop/Q3 budget.xlsx'],
      files: [],
      images: [shot],
      pathless: [web],
    })
    assert.equal(attached.length, 2, 'nothing more was registered')

    // A drag out of the studio's own Files pane is a reference into the project: typed, never a card.
    const payload = JSON.stringify({
      version: 1,
      workspaceId: 'workspace',
      rootPath: '/Users/dev/project',
      files: [{ path: '/Users/dev/project/src/app.ts', name: 'app.ts' }],
    })
    const studioDrag = {
      types: ['application/x-sprintengine-file-drop'],
      items: [],
      files: [],
      getData: (type: string) => (type === 'application/x-sprintengine-file-drop' ? payload : ''),
    } as unknown as DataTransfer
    assert.deepEqual(sortDroppedFiles(studioDrag, { attachImages: true, attachByPath: true }), {
      paths: ['/Users/dev/project/src/app.ts'],
      files: [],
      images: [],
      pathless: [],
    })
  } finally {
    holder.window = before
  }
})
