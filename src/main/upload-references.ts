import { appendFile, readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

// Which chats a file uploaded from a phone or a browser was sent in. The agent
// reads such a file by its path, in the turn it came with or any later one,
// so it has to outlive the week an upload is otherwise kept for as long as a
// chat that was sent it is kept. Each upload's folder
// (`<root>/<owner>/<upload>/<name>`, tailnet-file-uploads.ts and
// web-uploads.ts) gets a `.sent` file listing the transcript of every chat it
// was sent in; pruning keeps a folder while one of those transcripts is still
// on disk, and lets it go once every one is (the chat was deleted).

const SENT_MARK = '.sent'

/** The upload folder `path` is a file in, under one of `roots`; null for any other path. */
function uploadFolderOf(roots: readonly string[], path: string): string | null {
  for (const root of roots) {
    const inside = relative(root, path)
    if (!inside || isAbsolute(inside)) continue
    const parts = inside.split(sep)
    if (parts.length !== 3 || parts.some((part) => !part || part === '..' || part === '.')) continue
    return join(root, parts[0]!, parts[1]!)
  }
  return null
}

/** Note that the uploads among `paths` were sent in the chat whose transcript is `transcriptPath`. */
export async function noteUploadsSent(
  roots: readonly string[],
  paths: readonly string[],
  transcriptPath: string,
): Promise<void> {
  if (roots.length === 0 || !transcriptPath) return
  const folders = new Set(paths.flatMap((path) => uploadFolderOf(roots, path) ?? []))
  for (const folder of folders) {
    const mark = join(folder, SENT_MARK)
    try {
      const known = await readFile(mark, 'utf8').catch(() => '')
      if (known.split('\n').includes(transcriptPath)) continue
      await appendFile(mark, `${transcriptPath}\n`, { mode: 0o600 })
    } catch {
      // The upload is gone already, or not ours to write to: nothing to keep.
    }
  }
}

/** Whether a chat the upload in `folder` was sent in is still kept. */
export function uploadStillSent(folder: string): boolean {
  let known: string
  try {
    known = readFileSync(join(folder, SENT_MARK), 'utf8')
  } catch {
    return false
  }
  return known.split('\n').some((transcript) => transcript.length > 0 && existsSync(transcript))
}
