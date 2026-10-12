import { useSyncExternalStore } from 'react'

// A phone's width (phase 9 spec, 7.2; owner decision 5): below 640 px the
// shell switches layout, with the same components. The sidebar and the
// content take turns at the full width instead of sharing it, and the rail
// goes with the sidebar. In practice it is a phone's browser; a desktop
// window gets this narrow only at its narrowest, zoomed to level 2 (four
// steps of Zoom In).

export const NARROW_VIEWPORT_QUERY = '(max-width: 639px)'

function query(): MediaQueryList | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(NARROW_VIEWPORT_QUERY)
}

function subscribe(onChange: () => void): () => void {
  const list = query()
  if (!list) return () => undefined
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

const read = () => query()?.matches === true

export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
