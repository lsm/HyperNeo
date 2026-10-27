import type { TaskPriority } from '@hyperneo/shared/types/task-core';
import { orderWork } from './order.ts';

export interface WorkCandidate {
  id: string;
  group: string | null;
  priority: TaskPriority;
  createdAt: number;
  worker: string | null;
}

export interface RunningWork {
  group: string | null;
  worker: string | null;
  idle?: boolean;
}

export function planWorkQueue(
  candidates: readonly WorkCandidate[],
  running: readonly RunningWork[],
  limits: { running: number; perGroup: number }
): { start: string[]; queued: string[] } {
  const perGroup = new Map<string | null, number>();
  const busy = new Set(running.flatMap((row) => row.worker ?? []));
  const active = running.filter((row) => !row.idle);
  for (const row of active) perGroup.set(row.group, (perGroup.get(row.group) ?? 0) + 1);
  let total = active.length;
  const start: string[] = [];
  const queued: string[] = [];
  for (const item of orderWork(candidates)) {
    const inGroup = perGroup.get(item.group) ?? 0;
    if (
      total >= limits.running ||
      (item.group !== null && inGroup >= limits.perGroup) ||
      (item.worker && busy.has(item.worker))
    ) {
      queued.push(item.id);
      continue;
    }
    start.push(item.id);
    total += 1;
    perGroup.set(item.group, inGroup + 1);
    if (item.worker) busy.add(item.worker);
  }
  return { start, queued };
}
