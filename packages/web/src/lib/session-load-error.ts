/**
 * Session-load error classification.
 *
 * The backend surfaces several distinct failure modes for a session load, but
 * historically the UI collapsed every one into a single "Failed to load
 * session" screen. This module turns the raw RPC error (plus the transport
 * state at the moment it failed) into a discriminated kind so the UI can show
 * an accurate, actionable state instead.
 *
 * Distinct classes surfaced (task #873):
 *  - disconnected / reconnecting (transport down)        → transient, retain
 *  - request timeout                                      → transient, retry
 *  - session not found (deleted / never existed)          → confirmed gone
 *  - session archived / terminated (from `status` field)  → confirmed gone
 *  - unauthorized                                         → confirmed gone
 *  - unknown failure                                      → retry
 *
 * The daemon emits these as plain `Error` messages (the MessageHub client
 * discards the structured `errorCode` on `handleResponse`), so classification
 * is message-based with the transport state as a tiebreaker for generic errors.
 * A "Session not found" reply is authoritative even if it lands while the
 * transport reports reconnecting — only connection-shaped (or generic) errors
 * fall back to the transport-derived `disconnected` kind.
 */

import type { ConnectionState } from './state';

/**
 * Kinds derivable from a load RPC failure (an error or a `null` result).
 * `archived` / `terminated` are NOT here — those are derived from a successful
 * load whose `sessionInfo.status` is archived/ended (see `SessionUnavailableKind`).
 */
export type SessionLoadErrorKind =
  | 'disconnected'
  | 'timeout'
  | 'not-found'
  | 'unauthorized'
  | 'unknown';

/**
 * Every reason a chat might be "unavailable" — the load-error kinds above plus
 * the two status-derived terminal kinds. Used by the unavailable-session view
 * to pick heading/detail/actions.
 */
export type SessionUnavailableKind = SessionLoadErrorKind | 'archived' | 'terminated';

/**
 * Kinds that represent a CONFIRMED, non-transient unavailability. The chat for
 * these is genuinely gone (or inaccessible) — there is nothing to recover, so
 * the UI shows one explicit unavailable-session state instead of looping the
 * loading skeleton or flashing "No messages yet".
 *
 * Transient kinds (`disconnected`, `timeout`, `unknown`) are NOT hard
 * unavailable: a temporary failure must stay in recovery / show a retry affordance.
 */
const HARD_UNAVAILABLE_KINDS: ReadonlySet<SessionUnavailableKind> = new Set([
  'not-found',
  'unauthorized',
  'archived',
  'terminated',
]);

export function isHardUnavailable(kind: SessionUnavailableKind | null | undefined): boolean {
  return !!kind && HARD_UNAVAILABLE_KINDS.has(kind);
}

interface ClassifiedLoadError {
  kind: SessionLoadErrorKind;
  message: string;
}

/**
 * Message-based classification of a single RPC error. Returns `null` when the
 * message doesn't match a known shape (caller falls back to transport state).
 */
function classifyByMessage(lower: string): SessionLoadErrorKind | null {
  // The MessageHub throws synchronously with this message when a request is
  // issued while the transport is not connected.
  if (lower.includes('not connected') || lower.includes('disconnected')) return 'disconnected';
  // `Request timeout: state.session (10000ms)` — the 10s hub default. Also the
  // messages.bySession guard throws `Unauthorized: session "…" not found`.
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  // Daemon: `Session not found`. LiveQuery guard: `Unauthorized: session "…" not found`.
  // The latter also matches the unauthorized branch below, but "not found" is
  // the more actionable classification for a missing session — check it first.
  if (lower.includes('not found')) return 'not-found';
  if (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('not allowed') ||
    lower.includes('permission')
  ) {
    return 'unauthorized';
  }
  return null;
}

/**
 * Classify a session-load failure into a kind + user-facing message.
 *
 * @param err     The error thrown by the `state.session` RPC (or a synthetic
 *                error for a `null` result).
 * @param conn    Transport state at the moment of failure. Used only to upgrade
 *                a generic/unknown error to `disconnected` when the transport
 *                is actually down — a definitive message always wins.
 */
export function classifySessionLoadError(err: unknown, conn: ConnectionState): ClassifiedLoadError {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lower = raw.toLowerCase();
  const byMessage = classifyByMessage(lower);
  const kind: SessionLoadErrorKind =
    byMessage ??
    (conn === 'disconnected' || conn === 'reconnecting' || conn === 'connecting'
      ? 'disconnected'
      : 'unknown');
  return { kind, message: loadErrorMessage(kind) };
}

/** User-facing one-liner for a transient/retryable load error. */
export function loadErrorMessage(kind: SessionLoadErrorKind): string {
  switch (kind) {
    case 'disconnected':
      return "Can't reach the server right now.";
    case 'timeout':
      return 'This is taking longer than expected.';
    case 'not-found':
      return 'This session is no longer available.';
    case 'unauthorized':
      return "You don't have access to this session.";
    default:
      return "Couldn't load this session.";
  }
}

export interface UnavailableDescription {
  /** Short headline (e.g. "Session unavailable"). */
  heading: string;
  /** Longer explanation shown under the heading. */
  detail: string;
}

/** Heading + detail copy for the unavailable-session view, per kind. */
export function describeUnavailable(kind: SessionUnavailableKind): UnavailableDescription {
  switch (kind) {
    case 'not-found':
      return {
        heading: 'Session unavailable',
        detail:
          'This session may have been deleted, or the link is out of date. Try refreshing, or go back.',
      };
    case 'archived':
      return {
        heading: 'Session archived',
        detail: 'This session has been archived and is no longer active.',
      };
    case 'terminated':
      return {
        heading: 'Session ended',
        detail: 'This session has ended and is no longer active.',
      };
    case 'unauthorized':
      return {
        heading: 'Session unavailable',
        detail: "You don't have access to this session.",
      };
    case 'disconnected':
      return {
        heading: "Can't reach the server",
        detail: 'Check your connection and try again.',
      };
    case 'timeout':
      return {
        heading: 'Taking longer than expected',
        detail: 'The session is taking a while to load. Try again in a moment.',
      };
    default:
      return {
        heading: "Couldn't load this session",
        detail: 'Something went wrong loading this session. Try again, or go back.',
      };
  }
}
