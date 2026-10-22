import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { Markdown } from './markdown.js'
import { CONVERSATION_VIEW_CSS, themeStyle, type ConversationViewTheme } from './theme.js'
import {
  createConversationFollower,
  DECISION_VERB,
  toolObject,
  toolVerb,
  stepWentWrong,
  type ConversationAddress,
  type ConversationDecisionRow,
  type ConversationFollowSource,
  type ConversationTimelineRow,
} from './timeline.js'

// A Studio conversation, read-only, for another app to show (phase 9 spec,
// 5.1 to 5.3; R58, R59). The app brings its own Studio connection, an
// `@sprintengine/agent-sdk` client's `conversations` (or anything that follows
// a conversation by its stream frames), and the view follows one conversation
// through `@sprintengine/conversation-timeline`, drawing its turns, replies,
// tool steps and decisions. It reads and never acts: it sends nothing,
// answers nothing and opens nothing; a link goes to `onLink`.
//
// By default it draws inside a shadow root it makes, so the page's styles and
// the view's do not meet; `isolation="none"` draws in the page, its rules
// scoped to `.se-conversation` under `@layer sprintengine`.

export type ConversationViewProps = {
  /** How the view follows the conversation: an agent SDK client's `conversations`. */
  source: ConversationFollowSource
  conversation: ConversationAddress
  theme?: ConversationViewTheme
  isolation?: 'shadow' | 'none'
  /** Turns a page of history holds. */
  turnLimit?: number
  /** What the agent is called in the byline. */
  assistantName?: string
  /** A link the person clicked. Default: a new tab, without opener or referrer. */
  onLink?: (href: string) => void
  /** Told as the conversation changes: how many turns, and whether one is running. */
  onState?: (state: { turns: number; working: boolean }) => void
  className?: string
}

const openLink = (href: string) => {
  window.open(href, '_blank', 'noopener,noreferrer')
}

function useSystemMode(): 'light' | 'dark' {
  const query = typeof window === 'undefined' ? null : window.matchMedia?.('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(query?.matches === true)
  useEffect(() => {
    if (!query) return undefined
    const change = () => setDark(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [query])
  return dark ? 'dark' : 'light'
}

export function ConversationView(props: ConversationViewProps): React.JSX.Element {
  const systemMode = useSystemMode()
  const mode = !props.theme?.mode || props.theme.mode === 'system' ? systemMode : props.theme.mode
  const style = useMemo(() => themeStyle(mode, props.theme?.tokens), [mode, props.theme?.tokens])
  const body = (
    <div
      className={['se-conversation', props.className].filter(Boolean).join(' ')}
      data-mode={mode}
      style={style as React.CSSProperties}
    >
      <Timeline {...props} />
    </div>
  )
  if (props.isolation === 'none')
    return (
      <>
        <style>{`@layer sprintengine {${CONVERSATION_VIEW_CSS}}`}</style>
        {body}
      </>
    )
  return <ShadowHost>{body}</ShadowHost>
}

/** A host element with an open shadow root holding the view and its stylesheet. */
function ShadowHost({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [root, setRoot] = useState<ShadowRoot | null>(null)
  useEffect(() => {
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    if (
      'adoptedStyleSheets' in shadow &&
      typeof CSSStyleSheet === 'function' &&
      'replaceSync' in CSSStyleSheet.prototype
    ) {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(CONVERSATION_VIEW_CSS)
      shadow.adoptedStyleSheets = [sheet]
    } else {
      const style = document.createElement('style')
      style.textContent = CONVERSATION_VIEW_CSS
      shadow.append(style)
    }
    setRoot(shadow)
  }, [host])
  return <div ref={setHost}>{root ? createPortal(children, root) : null}</div>
}

function Timeline(props: ConversationViewProps): React.JSX.Element {
  const { source, conversation, turnLimit } = props
  const follower = useMemo(
    () => createConversationFollower(source, conversation, turnLimit === undefined ? {} : { turnLimit }),
    // A new address is a new conversation; the same one keeps its follower.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the address, not the object
    [source, conversation.workspaceId, conversation.agentId, conversation.workspaceRoot, turnLimit],
  )
  useEffect(() => () => follower.dispose(), [follower])
  const state = useSyncExternalStore(follower.subscribe, follower.getState, follower.getState)
  const turns = state.rows.filter((row) => row.kind === 'user').length
  const working = state.projection.activeTurn
  const onState = props.onState
  useEffect(() => onState?.({ turns, working }), [onState, turns, working])
  const onLink = props.onLink ?? openLink
  const assistantName = props.assistantName ?? 'Agent'

  if (state.error && state.rows.length === 0) return <p className="se-note se-failed">{state.error}</p>
  if (!state.hydrated && state.rows.length === 0) return <p className="se-note">Opening the conversation…</p>
  if (state.rows.length === 0) return <p className="se-note">This conversation has no messages yet.</p>
  return (
    <div role="log" aria-label="Conversation" aria-live="polite">
      {state.hasMore ? (
        <button
          type="button"
          className="se-earlier"
          disabled={state.loadingEarlier}
          onClick={() => void follower.loadEarlier()}
        >
          {state.loadingEarlier ? 'Loading…' : 'Show earlier messages'}
        </button>
      ) : null}
      {state.rows.map((row) => (
        <Row key={row.id} row={row} assistantName={assistantName} onLink={onLink} />
      ))}
    </div>
  )
}

function decisionLabel(row: ConversationDecisionRow): string {
  if (row.kind === 'decisionGroup') return `${DECISION_VERB[row.status]} ${row.label}`
  const status = row.entry.status
  return `${status === 'pending' ? 'Waiting for an answer' : DECISION_VERB[status]}: ${row.entry.summary}`
}

function Row({
  row,
  assistantName,
  onLink,
}: {
  row: ConversationTimelineRow
  assistantName: string
  onLink: (href: string) => void
}): React.JSX.Element | null {
  switch (row.kind) {
    case 'user':
      return (
        <div className="se-row se-user" data-se-turn={row.id}>
          {row.entry.text}
        </div>
      )
    case 'assistant':
      return (
        <div className="se-row">
          <div className="se-byline">
            {assistantName}
            {row.entry.modelId ? ` · ${row.entry.modelId}` : ''}
          </div>
          {row.tools.length > 0 ? (
            <ul className="se-steps" aria-label="Steps">
              {row.tools.map((tool) => (
                <li key={tool.id} className={stepWentWrong(tool) ? 'se-step-failed' : undefined}>
                  {toolVerb(tool.name, tool.status === 'running')} <code>{toolObject(tool) || tool.name}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {row.decisions.map((decision) => (
            <p key={decision.id} className="se-note">
              {decisionLabel(decision)}
            </p>
          ))}
          {row.entry.text ? <Markdown text={row.entry.text} onLink={onLink} /> : null}
          {row.entry.status === 'failed' ? (
            <p className="se-note se-failed">
              The turn failed{row.entry.failureReason ? `: ${row.entry.failureReason}` : '.'}
            </p>
          ) : row.entry.status === 'interrupted' ? (
            <p className="se-note">Interrupted</p>
          ) : null}
        </div>
      )
    case 'approval':
      return (
        <div className="se-row">
          {row.decisions.map((decision) => (
            <p key={decision.id} className="se-note">
              {decisionLabel(decision)}
            </p>
          ))}
        </div>
      )
    case 'compaction':
      return <p className="se-row se-note">Earlier messages were summarised to make room.</p>
    case 'handoff':
      return <p className="se-row se-note">Handed off to a new session.</p>
    case 'commandOutput':
      return (
        <div className="se-row">
          {row.entry.command ? <div className="se-byline">/{row.entry.command}</div> : null}
          <pre>{row.entry.output}</pre>
        </div>
      )
    case 'working':
      return <p className="se-row se-note">{row.label}</p>
    default:
      return null
  }
}
