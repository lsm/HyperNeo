import type { SpaceTask } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type SummarySpaceTask, spaceStore } from '../lib/space-store';

const MAX_DETAIL_RETRIES = 2;

export function useResolvedSpaceTask(task: SummarySpaceTask | null): SpaceTask | null {
  const detail = task ? spaceStore.taskDetails.value.get(task.id) : undefined;
  const [retryNonce, setRetryNonce] = useState(0);
  const retriesRef = useRef(0);

  useEffect(() => {
    retriesRef.current = 0;
  }, [task?.id]);

  useEffect(() => {
    if (!task) return;
    if (!task.descriptionTruncated && !task.resultTruncated) return;
    if (detail && detail.updatedAt >= task.updatedAt) return;
    let cancelled = false;
    spaceStore
      .ensureTaskDetail(task.id, task.updatedAt)
      .then((resolved) => {
        if (cancelled || resolved) return;
        if (retriesRef.current >= MAX_DETAIL_RETRIES) return;
        retriesRef.current += 1;
        setTimeout(() => {
          if (!cancelled) setRetryNonce((n) => n + 1);
        }, 3000 * retriesRef.current);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task, detail, retryNonce]);

  if (!task) return null;
  if (detail && detail.updatedAt >= task.updatedAt) return detail;
  return task;
}
