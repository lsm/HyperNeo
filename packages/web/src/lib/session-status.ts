import type { AgentProcessingState } from '@hyperneo/shared';
import { computed, signal } from '@preact/signals';
import { currentSessionIdSignal } from './signals.ts';
import { sessions } from './state.ts';

const UNREAD_STORAGE_KEY = 'kai:session-last-seen';

export interface SessionStatusInfo {
  processingState: AgentProcessingState;
  unreadCount: number;
}

const lastSeenMessageCounts = signal<Map<string, number>>(new Map());
let disposeTracking: (() => void) | undefined;

function loadLastSeenCounts(): Map<string, number> {
  try {
    const stored = localStorage.getItem(UNREAD_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as Record<string, number>;
      return new Map(Object.entries(data));
    }
  } catch {}
  return new Map();
}

function saveLastSeenCounts(counts: Map<string, number>): void {
  try {
    const data = Object.fromEntries(counts);
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function parseProcessingState(
  processingState?: string | AgentProcessingState
): AgentProcessingState {
  if (!processingState) {
    return { status: 'idle' };
  }

  try {
    const parsed =
      typeof processingState === 'string' ? JSON.parse(processingState) : processingState;
    return parsed && typeof parsed === 'object' && typeof parsed.status === 'string'
      ? (parsed as AgentProcessingState)
      : { status: 'idle' };
  } catch {
    return { status: 'idle' };
  }
}

export function initSessionStatusTracking(): void {
  disposeTracking?.();
  lastSeenMessageCounts.value = loadLastSeenCounts();
  const syncReadCounts = () => {
    const currentId = currentSessionIdSignal.value;
    const previous = lastSeenMessageCounts.peek();
    const next = new Map(previous);
    for (const session of sessions.value) {
      const count = session.metadata.messageCount || 0;
      const seen = previous.get(session.id);
      if (session.id === currentId || (seen !== undefined && seen > count)) {
        next.set(session.id, count);
      }
    }
    if (next.size === previous.size && [...next].every(([id, count]) => previous.get(id) === count))
      return;
    lastSeenMessageCounts.value = next;
    saveLastSeenCounts(next);
  };
  const disposeSelection = currentSessionIdSignal.subscribe(syncReadCounts);
  const disposeSessions = sessions.subscribe(syncReadCounts);
  disposeTracking = () => {
    disposeSelection();
    disposeSessions();
  };
}

export const allSessionStatuses = computed<Map<string, SessionStatusInfo>>(() => {
  const statuses = new Map<string, SessionStatusInfo>();

  const lastSeen = lastSeenMessageCounts.value;
  const sessionList = sessions.value;
  const currentId = currentSessionIdSignal.value;

  for (const session of sessionList) {
    const processingState = parseProcessingState(session.processingState);

    const lastSeenCount = lastSeen.get(session.id) ?? 0;
    const currentCount = session.metadata.messageCount || 0;
    const unreadCount = currentId !== session.id ? Math.max(0, currentCount - lastSeenCount) : 0;

    statuses.set(session.id, {
      processingState,
      unreadCount,
    });
  }

  return statuses;
});
