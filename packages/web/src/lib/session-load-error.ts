import type { ConnectionState } from './state';

export type SessionLoadErrorKind =
  | 'disconnected'
  | 'timeout'
  | 'not-found'
  | 'unauthorized'
  | 'unknown';

export type SessionUnavailableKind = SessionLoadErrorKind | 'archived' | 'terminated';

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

function classifyByMessage(lower: string): SessionLoadErrorKind | null {
  if (lower.includes('not connected') || lower.includes('disconnected')) return 'disconnected';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
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
  heading: string;
  detail: string;
}

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
