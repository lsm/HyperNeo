import type { WorkRef, WorkSummary } from './types.ts';

export interface WorkerReuseFacts {
  sameAskAt: number | null;
  settledAt: number | null;
}

export interface WorkerReuseCandidate extends WorkerReuseFacts {
  work: WorkSummary;
  free: boolean;
}

export function chooseReusableWorker(
  candidates: readonly WorkerReuseCandidate[],
  request: {
    adapter: string;
    folder: string;
    refreshStatus: boolean;
    excludeRefs?: readonly WorkRef[];
  }
): WorkerReuseCandidate | undefined {
  return candidates
    .filter(
      ({ work, free }) =>
        free &&
        work.ref.adapter === request.adapter &&
        !work.ref.daemon &&
        work.place.folder === request.folder &&
        (work.status === 'done' || (work.status === 'running' && request.refreshStatus)) &&
        !request.excludeRefs?.some(
          (ref) =>
            ref.adapter === work.ref.adapter &&
            ref.id === work.ref.id &&
            ref.daemon === work.ref.daemon
        )
    )
    .toSorted(
      (a, b) =>
        (b.sameAskAt ?? Number.MIN_SAFE_INTEGER) - (a.sameAskAt ?? Number.MIN_SAFE_INTEGER) ||
        (a.settledAt ?? Number.MAX_SAFE_INTEGER) - (b.settledAt ?? Number.MAX_SAFE_INTEGER)
    )[0];
}
