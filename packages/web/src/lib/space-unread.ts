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
  } catch {}
  return new Map();
}

function saveLastSeen(counts: Map<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(counts)));
  } catch {}
}

export function getSpaceSessionUnreadCount(id: string, messageCount: number | undefined): number {
  const seen = lastSeenCounts.value.get(id) ?? 0;
  return Math.max(0, (messageCount ?? 0) - seen);
}

export function markSpaceSessionRead(id: string, messageCount: number | undefined): void {
  const current = messageCount ?? 0;
  if ((lastSeenCounts.value.get(id) ?? 0) >= current) return;
  const next = new Map(lastSeenCounts.value);
  next.set(id, current);
  lastSeenCounts.value = next;
  saveLastSeen(next);
}

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

export const spaceSessionLastSeen = lastSeenCounts;

function loadLastSeenTasks(): Map<string, number> {
  try {
    const stored = localStorage.getItem(TASK_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored) as Record<string, number>;
      return new Map(Object.entries(data));
    }
  } catch {}
  return new Map();
}

function saveLastSeenTasks(counts: Map<string, number>): void {
  try {
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(Object.fromEntries(counts)));
  } catch {}
}

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

export function isSpaceTaskUnread(id: string, updatedAt: number): boolean {
  const seen = lastSeenTaskUpdates.value.get(id);
  return seen !== undefined && updatedAt > seen;
}

export function markSpaceTaskRead(id: string, updatedAt: number): void {
  if ((lastSeenTaskUpdates.value.get(id) ?? 0) >= updatedAt) return;
  const next = new Map(lastSeenTaskUpdates.value);
  next.set(id, updatedAt);
  lastSeenTaskUpdates.value = next;
  saveLastSeenTasks(next);
}

export const spaceTaskLastSeen = lastSeenTaskUpdates;
