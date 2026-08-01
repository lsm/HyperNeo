/**
 * Session Status Tracking
 *
 * Tracks session processing states and unread counts for sidebar display.
 *
 * Features:
 * - Uses Session.processingState field from unified state.sessions channel
 * - NO per-session subscriptions (prevents rate limit issues)
 * - Tracks agent processing states (idle, queued, processing)
 * - Tracks unread counts using localStorage persistence
 *
 * Phase/lifecycle tones are derived from the unified indicator foundation
 * (session-processing-phase.ts / session-lifecycle-status.ts) by consumers;
 * this module only carries the raw state + unread count.
 *
 * Architecture Note:
 * Previously, this module subscribed to per-session state channels for every
 * session to track processing states. This caused subscription rate limit
 * issues (>50 ops/sec) when many sessions existed. The fix uses the persisted
 * processingState field from the Session object in the global sessions channel.
 */

import type { AgentProcessingState } from '@hyperneo/shared';
import { computed, signal } from '@preact/signals';
import { currentSessionIdSignal } from './signals.ts';
import { sessions } from './state.ts';

/**
 * Storage key for unread tracking
 */
const UNREAD_STORAGE_KEY = 'kai:session-last-seen';

/**
 * Session status info for UI display
 */
export interface SessionStatusInfo {
  /** Current processing state */
  processingState: AgentProcessingState;
  /** Number of unseen messages (0 when the session is read/current) */
  unreadCount: number;
}

/**
 * Map of session ID to last seen message count
 * Persisted to localStorage
 */
const lastSeenMessageCounts = signal<Map<string, number>>(new Map());

/**
 * Load last seen counts from localStorage
 */
function loadLastSeenCounts(): Map<string, number> {
  try {
    const stored = localStorage.getItem(UNREAD_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as Record<string, number>;
      return new Map(Object.entries(data));
    }
  } catch {
    // Ignore errors loading unread data
  }
  return new Map();
}

/**
 * Save last seen counts to localStorage
 */
function saveLastSeenCounts(counts: Map<string, number>): void {
  try {
    const data = Object.fromEntries(counts);
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore errors saving to localStorage
  }
}

/**
 * Parse processingState from Session object
 *
 * The field can be in two formats:
 * 1. JSON string (when from database) - needs JSON.parse
 * 2. Object (when from delta broadcast) - use directly
 *
 * Server broadcasts processingState as object in delta updates for
 * client-side convenience (see state-manager.ts), but database stores
 * it as serialized JSON string.
 */
function parseProcessingState(
  processingState?: string | AgentProcessingState
): AgentProcessingState {
  if (!processingState) {
    return { status: 'idle' };
  }

  // If already an object, use directly
  if (typeof processingState === 'object') {
    return processingState;
  }

  // If string, parse as JSON
  try {
    return JSON.parse(processingState) as AgentProcessingState;
  } catch {
    return { status: 'idle' };
  }
}

/**
 * Initialize session status tracking
 * Call this after appState is initialized
 *
 * Note: Processing states are now read directly from Session.processingState
 * field in the sessions signal. No per-session subscriptions are needed.
 */
export function initSessionStatusTracking(): void {
  // Load persisted unread data
  lastSeenMessageCounts.value = loadLastSeenCounts();

  // When user clicks on a session, mark it as read
  currentSessionIdSignal.subscribe((sessionId) => {
    if (sessionId) {
      markSessionAsRead(sessionId);
    }
  });
}

/**
 * Mark a session as read (user has viewed it)
 */
function markSessionAsRead(sessionId: string): void {
  const sessionList = sessions.value;
  const session = sessionList.find((s) => s.id === sessionId);
  if (!session) return;

  const newCounts = new Map(lastSeenMessageCounts.value);
  newCounts.set(sessionId, session.metadata.messageCount);
  lastSeenMessageCounts.value = newCounts;
  saveLastSeenCounts(newCounts);
}

/**
 * Computed signal: all session statuses
 * Use this for reactive updates in UI
 *
 * Processing states are now derived from Session.processingState field
 * instead of per-session state channel subscriptions.
 */
export const allSessionStatuses = computed<Map<string, SessionStatusInfo>>(() => {
  const statuses = new Map<string, SessionStatusInfo>();

  // Trigger reactivity by accessing the signals
  const lastSeen = lastSeenMessageCounts.value;
  const sessionList = sessions.value;
  const currentId = currentSessionIdSignal.value;

  for (const session of sessionList) {
    // Parse processing state from Session.processingState field (JSON string)
    const processingState = parseProcessingState(session.processingState);

    // Calculate unread count: new messages since the session was last viewed.
    // The current session is always considered read.
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
