import '../../assets/index.css'
import React, { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'

import type { StudioClient } from '../../../../../packages/agent-sdk/src/index'
import { prefersReducedMotion } from '../../components/panels/agentChat/reducedMotion'
import { EmptyState } from '../../components/ui/EmptyState'
import { RootErrorBoundary } from '../../components/workspace/RootErrorBoundary'
import { connectEmbed, EmbedUnavailable } from './embedClient'
import { EmbeddedConversation } from './EmbeddedConversation'
import { postToHost, readHostMessage, type EmbedToHost } from './embedProtocol'

// The embed page's boot (phase 9 spec, 5.4). It reads the embed from its
// address, takes its token from the fragment (and removes it from the address
// and history at once) or from the framing page, connects, and draws the
// conversation. It talks to the framing page only on the embed's registered
// origins, which the server writes into the page.

const embedId = /\/embed\/conversation\/([\w-]+)/u.exec(window.location.pathname)?.[1] ?? ''
const origins = (document.querySelector('meta[name="sprintengine-embed-origins"]')?.getAttribute('content') ?? '')
  .split(' ')
  .filter(Boolean)
const framed = window.parent !== window
const host = framed ? window.parent : null
const tell = (message: EmbedToHost) => postToHost(message, origins, host)

function applyMode(mode: 'light' | 'dark' | 'system'): void {
  const dark =
    mode === 'dark' || (mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)
  document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light')
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('token')
window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)

function EmbedApp(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(fragmentToken)
  const [connected, setConnected] = useState<{
    client: StudioClient
    conversation: { workspaceId: string; agentId: string }
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    applyMode('system')
    const onMessage = (event: MessageEvent) => {
      const verdict = readHostMessage(event, origins, window.parent)
      if (verdict.kind === 'refuse') tell({ v: 1, type: 'error', code: verdict.code })
      if (verdict.kind !== 'accept') return
      const message = verdict.message
      if (message.type === 'theme') applyMode(message.mode)
      else if (message.type === 'token') setToken((current) => current ?? message.token)
      // A glide only for someone who has not asked for less motion: an
      // explicit 'smooth' is not toned down by the system setting.
      else
        document
          .querySelector(`[data-embed-turn="${CSS.escape(message.turnId)}"]`)
          ?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }
    window.addEventListener('message', onMessage)
    tell({ v: 1, type: 'ready', embedId })
    // A link opens in the framing page's control, never inside the frame.
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      event.preventDefault()
      if (framed && origins.length > 0) tell({ v: 1, type: 'link', href: anchor.href })
      else window.open(anchor.href, '_blank', 'noopener,noreferrer')
    }
    document.addEventListener('click', onClick, true)
    const resize = new ResizeObserver(() =>
      tell({ v: 1, type: 'resize', height: document.documentElement.scrollHeight }),
    )
    resize.observe(document.body)
    return () => {
      window.removeEventListener('message', onMessage)
      document.removeEventListener('click', onClick, true)
      resize.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!token || !embedId) return
    let current = true
    connectEmbed(embedId, token).then(
      (next) => {
        if (current) setConnected(next)
      },
      (failure: unknown) => {
        if (!current) return
        setError(failure instanceof EmbedUnavailable ? failure.message : 'Studio could not be reached.')
        tell({ v: 1, type: 'error', code: failure instanceof EmbedUnavailable ? 'embed_unavailable' : 'unreachable' })
      },
    )
    return () => {
      current = false
    }
  }, [token])

  const onState = useCallback(
    (state: { turns: number; working: boolean }) => tell({ v: 1, type: 'state', ...state }),
    [],
  )

  if (error) return <EmptyState title={error} />
  if (!token) return <EmptyState title="Waiting for this conversation’s link." />
  if (!connected) return <EmptyState title="Opening the conversation…" />
  return <EmbeddedConversation client={connected.client} conversation={connected.conversation} onState={onState} />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <RootErrorBoundary>
    <EmbedApp />
  </RootErrorBoundary>,
)
