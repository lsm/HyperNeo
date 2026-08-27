import type { SpaceTask } from '@hyperneo/shared';
import { useEffect } from 'preact/hooks';
import { type SummarySpaceTask, spaceStore } from '../lib/space-store';

export function useResolvedSpaceTask(task: SummarySpaceTask | null): SpaceTask | null {
  const detail = task ? spaceStore.taskDetails.value.get(task.id) : undefined;

  useEffect(() => {
    if (!task || detail) return;
    if (!task.descriptionTruncated && !task.resultTruncated) return;
    spaceStore.ensureTaskDetail(task.id).catch(() => {});
  }, [task, detail]);

  if (!task) return null;
  if (detail && detail.updatedAt >= task.updatedAt) return detail;
  return task;
}
