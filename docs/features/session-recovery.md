# Session load errors & mobile recovery UX

How the web client represents a session that can't be shown as a live chat —
stale/deleted/archived ids, transient connection failures, and overlays on
mobile. Covers the work in #871 (state isolation), #872 (session-scoped
reconnect), and #873 (this doc).

## The problem this solves

A deep link, browser back/forward, or agent-detail navigation can land on a
session id that is deleted, archived, or temporarily unreachable. Previously
every such case collapsed into a single, misleading **"Failed to load session"**
screen — and state contention (#871) could even show that error panel alongside
an unrelated interactive "No messages yet" empty chat. On mobile, the base chat
under an agent overlay also stayed focusable/scrollable behind the overlay.

## Error classes

The backend surfaces distinct failure modes; the client preserves them instead
of collapsing. Classification lives in
`packages/web/src/lib/session-load-error.ts` (`classifySessionLoadError`):

| Kind | Source | Surface |
|---|---|---|
| `disconnected` | transport down / reconnecting (`Not connected to transport`, or generic error while transport is down) | transient — retry |
| `timeout` | `Request timeout: state.session` (hub 10s) or the 30s load backstop | transient — retry |
| `not-found` | daemon throws `Session not found`, RPC returns `null`, or the `messages.bySession` guard throws `Unauthorized: session … not found` | confirmed gone |
| `unauthorized` | unauthorized / forbidden reply | confirmed gone |
| `unknown` | anything else | retry |

`archived` / `terminated` are **not** load errors — the `state.session` RPC
succeeds and the row still exists. They are derived from `sessionInfo.status`.

> The MessageHub client currently discards the structured `errorCode` on
> `handleResponse`, so classification is message-based with the transport state
> as a tiebreaker. A definitive server reply (e.g. `Session not found`) wins
> even when the transport reports reconnecting.

## Store model (`SessionStore`)

- `loadErrorKind: Signal<SessionLoadErrorKind | null>` — set **only** when the
  initial `state.session` fetch fails (or returns not-found). Reset on session
  switch, on a successful load commit, and when a valid `state.session` push
  arrives.
- `availability: Computed<SessionUnavailableKind | null>` — the single verdict
  the UI routes on: a hard-unavailable load kind (`not-found` / `unauthorized`),
  or `archived` / `terminated` from status, else `null` (ready / loading /
  recovering).
- **Transient recovery never sets a hard-unavailable kind.** The `retainOnError`
  refresh path returns before committing, so a temporary RPC failure during
  reconnect keeps `isRecovering` true and the transcript visible — it is never
  mistaken for a confirmed-missing session.

## UI routing (`ChatContainer`)

`resolveChatRoute` (pure, unit-tested) decides one of `pending` / `unavailable`
/ `loading` / `ready`:

- **unavailable (full-screen `UnavailableSessionView`)** — `not-found`,
  `unauthorized`, `timeout`, `disconnected`, `unknown`. There is no transcript
  for a session that never loaded, so this also guarantees an invalid nonempty
  session id **never** reaches the "No messages yet" placeholder.
- **archived / terminated** — the transcript stays readable; a non-blocking
  banner is shown and the composer is disabled. (A user archiving the session
  they're viewing keeps the history.)
- **recovering** — keeps the transcript read-only with a "Reconnecting…" banner;
  the composer and model controls stay disabled until that specific session is
  ready again.

### Unavailable-session actions

Context-aware, built in `ChatContainer`:

- **Try again** — always (re-selects the session).
- **Go back** — when `onBack` is provided (overlays, space session views).
- **Refresh** — when `onRefreshAgent` is provided (long-horizon / coordinator).
- **Start new** — when `onRecreateAgent` is provided.

## Long-horizon agent refresh

`SpaceIsland.handleRefreshAgentRecord` re-fetches the agent list
(`spaceStore.refreshLongHorizonAgents`) and re-resolves the session id: for a
`space:agent:<spaceId>:<agentId>` id it looks the agent up by id and, if its
`sessionId` changed (restored/recreated), navigates to the live one instead of
looping on a deleted id. The coordinator id (`space:chat:<spaceId>`) is stable,
so it just retries. Helpers in `packages/web/src/lib/space-agent-session.ts`.

## Mobile: one interactive surface

When an `AgentOverlayChat` is open, `SpaceIsland` sets `inert` + `aria-hidden`
on the base chat/pane layer (`baseLayerProps`). The overlay's Portal + backdrop
+ focus-trap already isolate it visually and by keyboard; `inert` closes the
accessibility gap so the underlying composer/scroll is neither focusable nor in
the a11y tree. It is re-enabled the instant the overlay closes. This is the
correct pattern for an `aria-modal="true"` dialog and is not gated to a viewport
width.

## Connection indicator harmonization

`SessionStatusBar`/`ConnectionStatus` now reflect the **per-session** recovery
state: when the transport is connected but this session is still rejoining its
channel, the status dot reads "Reconnecting…" (matching the in-chat banner)
instead of a contradictory "Ready", and the model pill is disabled while
recovering. The global `ConnectionOverlay` (transport-level) and the per-session
banner thus no longer fight.
