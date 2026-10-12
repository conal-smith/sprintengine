import { showToast } from '../store/toastStore'

/**
 * An Option-click (Alt-click) on a web link opens it in the system browser,
 * as a plain click does.
 *
 * Chromium reads an Alt-click on a link as "download the linked file": the
 * click never becomes a window-open, so main's handler that hands every
 * `_blank` link to the system browser never sees it, and the page is saved
 * instead. Option-click is also how people steer a link through a browser
 * picker, which reads the modifier as the link arrives, so the link is opened
 * here, during the click, while the key is still down.
 *
 * Only the links the app already sends to the browser are taken: an anchor
 * with `target="_blank"` and a web or mail address. A click something else
 * has already handled is left to it. Main checks the address again before
 * opening it.
 */
export function openAltClickedLink(event: MouseEvent, open: (url: string) => void): boolean {
  if (event.defaultPrevented || !event.altKey || event.button !== 0) return false
  const target = event.target
  const anchor = target instanceof Element ? target.closest('a[href]') : null
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return false
  if (!/^(?:https?|mailto):/iu.test(anchor.href)) return false
  event.preventDefault()
  open(anchor.href)
  return true
}

/** Installs `openAltClickedLink` for the window, after React's own handlers. */
export function bindAltClickLinks(): void {
  document.addEventListener('click', (event) => {
    openAltClickedLink(event, (url) => {
      void window.api
        .openExternal(url)
        .then((result) => {
          if (result && !result.ok)
            showToast({ tone: 'error', title: 'Could not open the link', description: result.message })
        })
        .catch(() => showToast({ tone: 'error', title: 'Could not open the link' }))
    })
  })
}
