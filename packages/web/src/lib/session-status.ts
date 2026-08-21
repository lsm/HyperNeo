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

  if (typeof processingState === 'object') {
    return processingState;
  }

  try {
    return JSON.parse(processingState) as AgentProcessingState;
  } catch {
    return { status: 'idle' };
  }
}

export function initSessionStatusTracking(): void {
  lastSeenMessageCounts.value = loadLastSeenCounts();

  currentSessionIdSignal.subscribe((sessionId) => {
    if (sessionId) {
      markSessionAsRead(sessionId);
    }
  });
}

function markSessionAsRead(sessionId: string): void {
  const sessionList = sessions.value;
  const session = sessionList.find((s) => s.id === sessionId);
  if (!session) return;

  const newCounts = new Map(lastSeenMessageCounts.value);
  newCounts.set(sessionId, session.metadata.messageCount);
  lastSeenMessageCounts.value = newCounts;
  saveLastSeenCounts(newCounts);
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
