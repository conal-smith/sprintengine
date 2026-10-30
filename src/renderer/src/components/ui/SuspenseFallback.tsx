import { LoadingOverlay } from './LoadingOverlay'

// Fallback for lazy (`React.lazy` + `Suspense`) surfaces — the Settings
// overlay, the new-workspace wizard, and the first-run onboarding workspace step.
// Renders the kit's `LoadingOverlay` (pulsed dot + one sentence) and fills its
// container. The `.suspense-fallback` class delays the fade-in (see index.css)
// so a fast chunk load never flashes.
//
// This used to render the `SprintEngineSpinner` brand mark: a hex-gradient glyph
// tuned for dark, so every light theme got a washed grey mark — and it was the
// application icon. The spinner spec names one working mark and the overlay for
// panel scale; a loader is not a place for the brand (ruled 2026-09-02).
export function SuspenseFallback({ label = 'Loading' }: { label?: string }) {
  return (
    <div aria-busy="true" className="suspense-fallback flex h-full w-full flex-1 items-center justify-center">
      <LoadingOverlay label={label} />
    </div>
  )
}
