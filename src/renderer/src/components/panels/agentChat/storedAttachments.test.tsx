import { test, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import type { ConversationStoredImageAttachment } from '../../../../../shared/conversation-runtime'

test('a replayed bubble reads its images back by reference, and says so when one is gone', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const reads: string[] = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationAttachment: async ({ ref }: { ref: string }) => {
        reads.push(ref)
        return ref.endsWith('kept.png')
          ? { ok: true, mediaType: 'image/png', dataBase64: 'Zm9v' }
          : { ok: false, message: 'That attachment is no longer on this machine.' }
      },
      // The machine a remote chat runs on serves its own, as a data URL.
      meshConversationAttachment: async ({ ref }: { ref: string }) => {
        reads.push(`remote:${ref}`)
        return ref.endsWith('kept.png')
          ? { ok: true, dataUrl: 'data:image/png;base64,YmF6' }
          : { ok: false, code: 'images_unsupported', message: 'This picture is on mac-mini.' }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { StoredAttachmentThumbnail } = await import('./storedAttachments')
  const { ConversationTransportProvider, createRemoteConversationTransport } = await import('./conversationTransport')
  const kept: ConversationStoredImageAttachment = {
    id: 'a',
    mediaType: 'image/png',
    name: 'cat.png',
    byteLength: 3,
    ref: 'f/kept.png',
  }
  const gone: ConversationStoredImageAttachment = { id: 'b', mediaType: 'image/png', byteLength: 3, ref: 'f/gone.png' }
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <>
          <StoredAttachmentThumbnail attachment={kept} className="h-16 w-16" />
          <StoredAttachmentThumbnail attachment={gone} className="h-16 w-16" />
        </>,
      )
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,Zm9v')
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('cat.png')
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Attached image, not available')
    // A second bubble showing the same image is served from memory.
    await act(async () => {
      root.render(<StoredAttachmentThumbnail attachment={kept} className="h-16 w-16" />)
    })
    expect(reads.filter((ref) => ref === kept.ref)).toHaveLength(1)

    // A conversation on another machine keeps its images there, and they are
    // asked of it, never read from this machine's store.
    const remote = createRemoteConversationTransport({
      key: { connectionId: 'mac-mini', workspaceId: 'w', agentId: 'a' },
      machineName: 'mac-mini',
      access: 'read',
    })
    await act(async () => {
      root.render(
        <ConversationTransportProvider value={remote}>
          <StoredAttachmentThumbnail attachment={{ ...kept, ref: 'f/remote-kept.png' }} className="h-16 w-16" />
        </ConversationTransportProvider>,
      )
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YmF6')
    expect(reads).toContain('remote:f/remote-kept.png')
    expect(reads).not.toContain('f/remote-kept.png')
    // One that machine cannot serve still says an image was sent.
    await act(async () => {
      root.render(
        <ConversationTransportProvider value={remote}>
          <StoredAttachmentThumbnail attachment={{ ...kept, ref: 'f/remote-old.png' }} className="h-16 w-16" />
        </ConversationTransportProvider>,
      )
    })
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('cat.png, not available')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a picture just sent draws from memory on its first frame, with no read', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator })
  const reads: string[] = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationAttachment: async ({ ref }: { ref: string }) => {
        reads.push(ref)
        return { ok: false, message: 'not read' }
      },
    },
  })
  try {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { StoredAttachmentThumbnail, rememberSentAttachment } = await import('./storedAttachments')
    rememberSentAttachment('f/sent.png', {
      id: 'sent',
      mediaType: 'image/png',
      dataBase64: 'YmFy',
      byteLength: 3,
      name: 'sent.png',
    })
    const html = renderToStaticMarkup(
      <StoredAttachmentThumbnail
        attachment={{ id: 'sent', mediaType: 'image/png', byteLength: 3, ref: 'f/sent.png', name: 'sent.png' }}
        className="h-16 w-16"
      />,
    )
    expect(html).toContain('src="data:image/png;base64,YmFy"')
    expect(reads).toEqual([])
  } finally {
    dom.window.close()
    for (const key of ['window', 'document', 'navigator']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
