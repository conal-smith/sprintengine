import { useState } from 'react'
import { LinkButton, MediaButton } from '../../ui'
import { showToast } from '../../../store/toastStore'
import { isHomePath, isPreviewableImagePath, useLocalImage } from './useLocalImage'

type ImageSource = { kind: 'web'; url: string } | { kind: 'data'; url: string } | { kind: 'path'; path: string }

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu

// What an image in a reply points at. A web or data URL is shown as it is; a
// `file:` URL or a path is a file on the agent's disk and is read through main.
// Any other scheme, and a path that is not a picture, is stated by its alt text.
export function conversationImageSource(src: string): ImageSource | null {
  const value = src.trim()
  if (/^https?:\/\//iu.test(value)) return { kind: 'web', url: value }
  if (DATA_IMAGE.test(value)) return { kind: 'data', url: value }
  let path = value
  if (/^file:/iu.test(value)) {
    try {
      path = decodeURIComponent(new URL(value).pathname).replace(/^\/([a-z]:\/)/iu, '$1')
    } catch {
      return null
    }
  } else if (/^[a-z][a-z0-9+.-]*:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)) {
    return null
  } else {
    // A markdown destination escapes its spaces (`My%20Shot.png`); the file does not.
    try {
      path = decodeURIComponent(value)
    } catch {
      path = value
    }
  }
  return isPreviewableImagePath(path) ? { kind: 'path', path } : null
}

async function openImage(source: ImageSource, dataUrl: string | undefined, name: string, open?: () => void) {
  try {
    if (source.kind === 'web') {
      const result = await window.api.openExternal(source.url)
      if (!result.ok) throw new Error(result.message)
      return
    }
    if (source.kind === 'path' && open) return open()
    const match = dataUrl ? DATA_IMAGE.exec(dataUrl) : null
    if (!match) throw new Error('The image could not be read')
    await window.api.openImageAttachment({ mediaType: match[1], dataBase64: match[2].replace(/\s/gu, ''), name })
  } catch (error) {
    showToast({
      tone: 'error',
      title: 'Could not open that image',
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

// A picture the agent put in its reply — a screenshot it took, a chart it drew —
// shown rather than described. It is bounded so a full-resolution capture cannot
// push the conversation off screen. The click opens it where a close look
// belongs: a file on this disk where the caller opens files, a web image in the
// browser, anything else in the operating system's viewer. A file on another
// machine, or one that is gone, says so in the place the picture would have been.
export function ConversationImage({
  src,
  alt,
  inLink = false,
  onOpenFile,
}: {
  src: string
  alt: string
  // Inside a link's label the link is the control; the image must not be a second one.
  inLink?: boolean
  // Opens a local image file in the app; without it the file goes to the OS viewer.
  onOpenFile?: (path: string) => void
}) {
  const source = conversationImageSource(src)
  const local = useLocalImage(source?.kind === 'path' ? source.path : null, { home: true })
  // A web image can still 404, and a broken-image glyph says less than the alt text.
  const [broken, setBroken] = useState<string>()
  // A web image waits for a click. The reply is the agent's text, and whatever
  // it read can steer that text: an image URL fetched on render is a request to
  // a host of the text's choosing, with anything it likes in the query string,
  // made before anyone has read the line. Local files and inline data make no
  // request, so they show at once.
  const [revealed, setRevealed] = useState<string>()
  const name = alt || (source?.kind === 'path' ? (source.path.split(/[\\/]/u).at(-1) ?? source.path) : 'Image')
  const unavailable = (reason: string) => (
    <span className="text-[color:var(--text-muted)]" title={source?.kind === 'path' ? source.path : undefined}>
      {alt ? `[Image: ${alt}]` : '[Image]'}
      <span className="sr-only">{` — ${reason}`}</span>
    </span>
  )
  if (!source) return unavailable('not an image this app can show')
  if (source.kind === 'path' && !local.resolved) return unavailable('the image is not on this machine')
  if (source.kind === 'path' && local.failed) return unavailable('the image is no longer available')
  if (source.kind === 'web' && revealed !== source.url) {
    let host = source.url
    try {
      host = new URL(source.url).host
    } catch {
      /* The full URL is a readable fallback. */
    }
    const label = `${alt ? `[Image: ${alt}]` : '[Image]'} · load from ${host}`
    return inLink ? (
      <span className="text-[color:var(--text-muted)]">{label}</span>
    ) : (
      <LinkButton ink="quiet" underline="always" title={source.url} onClick={() => setRevealed(source.url)}>
        {label}
      </LinkButton>
    )
  }
  const url = source.kind === 'path' ? local.src : source.url
  if (!url) return <span className="text-[color:var(--text-muted)]">{alt || 'Loading image…'}</span>
  if (broken === url) return unavailable('the image could not be loaded')
  const image = (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(url)}
      className="block max-h-80 max-w-full object-contain"
    />
  )
  if (inLink) return image
  const resolved = local.resolved
  return (
    <MediaButton
      aria-label={`Open ${name}`}
      className="my-2 w-fit max-w-full"
      onClick={() =>
        void openImage(
          source,
          url,
          name,
          // A `~/` path is expanded only by main, so the picture opens in the
          // system viewer rather than as a file the app would look up as typed.
          source.kind === 'path' && resolved && !isHomePath(resolved) && onOpenFile
            ? () => onOpenFile(resolved)
            : undefined,
        )
      }
    >
      {image}
    </MediaButton>
  )
}
