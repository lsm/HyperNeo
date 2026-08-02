/**
 * Space session unread tracking (client-local).
 *
 * Mirrors the global `session-status.ts` pattern: a localStorage-backed
 * last-seen map keyed by session id, compared against the `messageCount` the
 * `spaceSessions.bySpace` LiveQuery now carries. Space sessions aren't part of
 * the global sessions signal, so they need their own (still client-local)
 * tracking — no server-persisted unread state is introduced.
 */

import { signal } from '@preact/signals';

const STORAGE_KEY = 'kai:space-session-last-seen';
const TASK_STORAGE_KEY = 'kai:space-task-last-seen';

const lastSeenCounts = signal<Map<string, number>>(loadLastSeen());
const lastSeenTaskUpdates = signal<Map<string, number>>(loadLastSeenTasks());

function loadLastSeen(): Map<string, number> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as Record<string, number>;
      return new Map(Object.entries(data));
    }
  } catch {
    // Ignore errors loading unread data
  }
  return new Map();
}

function saveLastSeen(counts: Map<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(counts)));
  } catch {
    // Ignore errors saving unread data
  }
}

/**
 * Unread message count for a space session. Reactive: subscribe to
 * `lastSeenCounts` (re-exported) to recompute when a session is marked read.
 */
export function getSpaceSessionUnreadCount(id: string, messageCount: number | undefined): number {
  const seen = lastSeenCounts.value.get(id) ?? 0;
  return Math.max(0, (messageCount ?? 0) - seen);
}

/**
 * Mark a space session as read up to its current `messageCount`. No-op when the
 * stored count is already current so the signal reference stays stable and
 * renders don't churn.
 */
export function markSpaceSessionRead(id: string, messageCount: number | undefined): void {
  const current = messageCount ?? 0;
  if ((lastSeenCounts.value.get(id) ?? 0) >= current) return;
  const next = new Map(lastSeenCounts.value);
  next.set(id, current);
  lastSeenCounts.value = next;
  saveLastSeen(next);
}

/**
 * Lower any stored last-seen baseline that exceeds the session's current
 * `messageCount`. A rewind (or message deletion) drops the count below the old
 * high-water mark; without this, new post-rewind messages read as 0 unread
 * until the count climbs past the old peak. Call reactively as the session
 * list changes.
 */
export function syncSpaceSessionSeen(
  sessions: ReadonlyArray<{ id: string; messageCount?: number }>
): void {
  let changed = false;
  const next = new Map(lastSeenCounts.value);
  for (const s of sessions) {
    const current = s.messageCount ?? 0;
    const seen = next.get(s.id);
    if (seen !== undefined && seen > current) {
      next.set(s.id, current);
      changed = true;
    }
  }
  if (changed) {
    lastSeenCounts.value = next;
    saveLastSeen(next);
  }
}

/** Reactive handle so components recompute unread counts when state changes. */
export const spaceSessionLastSeen = lastSeenCounts;

// ---------------------------------------------------------------------------
// Task unread tracking (client-local)
// ---------------------------------------------------------------------------

function loadLastSeenTasks(): Map<string, number> {
  try {
    const stored = localStorage.getItem(TASK_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as Record<string, number>;
      return new Map(Object.entries(data));
    }
  } catch {
    // Ignore errors loading unread data
  }
  return new Map();
}

function saveLastSeenTasks(counts: Map<string, number>): void {
  try {
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(Object.fromEntries(counts)));
  } catch {
    // Ignore errors saving unread data
  }
}

/**
 * Seed the last-seen `updatedAt` for any task not yet known. Called as the task
 * list renders so a task is only "unread" when it is updated AFTER the user
 * first saw it — avoiding every task flashing unread on a cold space load.
 */
export function seedSpaceTasksSeen(tasks: ReadonlyArray<{ id: string; updatedAt: number }>): void {
  let changed = false;
  const next = new Map(lastSeenTaskUpdates.value);
  for (const t of tasks) {
    if (!next.has(t.id)) {
      next.set(t.id, t.updatedAt);
      changed = true;
    }
  }
  if (changed) {
    lastSeenTaskUpdates.value = next;
    saveLastSeenTasks(next);
  }
}

/** Whether a task has been updated since the user last viewed it. */
export function isSpaceTaskUnread(id: string, updatedAt: number): boolean {
  const seen = lastSeenTaskUpdates.value.get(id);
  // Unknown task (not yet seeded) is treated as read — seeding happens as the
  // list renders, so this just guards against a render before the seed effect.
  return seen !== undefined && updatedAt > seen;
}

/** Mark a task as seen up to its current `updatedAt`. */
export function markSpaceTaskRead(id: string, updatedAt: number): void {
  if ((lastSeenTaskUpdates.value.get(id) ?? 0) >= updatedAt) return;
  const next = new Map(lastSeenTaskUpdates.value);
  next.set(id, updatedAt);
  lastSeenTaskUpdates.value = next;
  saveLastSeenTasks(next);
}

/** Reactive handle so task rows recompute when last-seen state changes. */
export const spaceTaskLastSeen = lastSeenTaskUpdates;
