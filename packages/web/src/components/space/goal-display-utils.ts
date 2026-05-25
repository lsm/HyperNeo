import type { SpaceGoal, SpaceTask } from '@neokai/shared';

const RECENT_ACTIVITY_MS = 24 * 60 * 60 * 1000;

export function formatGoalMetricSnapshot(goal: SpaceGoal, limit = 3): string {
  const entries = Object.entries(goal.metrics);
  if (entries.length === 0) return 'No metrics recorded';
  return entries
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${String(value ?? '—')}`)
    .join(' · ');
}

export function getGoalLastActivityAt(goal: SpaceGoal, lastTask?: SpaceTask | null): number | null {
  const lastActivityAt = Math.max(goal.lastCheckInAt ?? 0, lastTask?.updatedAt ?? 0);
  return lastActivityAt || null;
}

export function getRecurringGoalActivityStatus(
  goal: SpaceGoal,
  lastTask?: SpaceTask | null
): 'active' | 'idle' | 'paused' {
  if (goal.status === 'paused') return 'paused';
  if (goal.activeTaskId) return 'active';
  const lastActivityAt = getGoalLastActivityAt(goal, lastTask);
  return lastActivityAt && lastActivityAt > Date.now() - RECENT_ACTIVITY_MS ? 'active' : 'idle';
}
