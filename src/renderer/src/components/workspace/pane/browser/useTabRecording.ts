import { useEffect } from 'react'

import { readRecordingTheme, startGuestRecording, type GuestRecording } from './browserRecording'
import { useRecordingTabsStore } from './recordingTabs'

/**
 * Record this tab when main asks (an agent's `browser.record_start`), and
 * stop when main says. A recording belongs to the tab's component: when the
 * tab closes, its recording ends with it and what was captured is kept.
 * While it runs, the pane keeps the tab painting out of view (`recordingTabs.ts`).
 */
export function useTabRecording(tabId: string, workspaceId: string): void {
  useEffect(() => {
    const { begin, end } = useRecordingTabsStore.getState()
    const running = new Map<string, GuestRecording>()
    /** This tab's recordings still starting, and those of them already asked to stop. */
    const starting = new Set<string>()
    const stopRequested = new Set<string>()
    let unmounted = false

    const offStart = window.api.onBrowserRecordingStart((start) => {
      if (start.tabId !== tabId) return
      const { recordingId } = start
      starting.add(recordingId)
      begin(recordingId, tabId, workspaceId)
      void (async () => {
        let recording: GuestRecording
        try {
          recording = await startGuestRecording(start, {
            onChunk: (bytes) => window.api.browserRecordingChunk(recordingId, bytes),
            onPointer: (listener) =>
              window.api.onBrowserPointer((event) => {
                if (event.tabId === tabId) listener(event)
              }),
            theme: readRecordingTheme(),
          })
        } catch (error) {
          starting.delete(recordingId)
          stopRequested.delete(recordingId)
          end(recordingId)
          window.api.browserRecordingStarted({
            recordingId,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          })
          return
        }
        starting.delete(recordingId)
        running.set(recordingId, recording)
        window.api.browserRecordingStarted({
          recordingId,
          ok: true,
          mimeType: recording.mimeType,
          width: recording.width,
          height: recording.height,
          cursor: recording.cursor,
        })
        if (unmounted || stopRequested.delete(recordingId)) recording.stop()
        const outcome = await recording.finished
        running.delete(recordingId)
        end(recordingId)
        window.api.browserRecordingEnded({ recordingId, ...outcome })
      })()
    })

    const offStop = window.api.onBrowserRecordingStop(({ recordingId }) => {
      const recording = running.get(recordingId)
      if (recording) recording.stop()
      else if (starting.has(recordingId)) stopRequested.add(recordingId)
    })

    return () => {
      unmounted = true
      offStart()
      offStop()
      for (const recording of running.values()) recording.stop()
    }
  }, [tabId, workspaceId])
}
