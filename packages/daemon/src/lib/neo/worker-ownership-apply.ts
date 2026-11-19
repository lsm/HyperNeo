import {
  inferWorkerOwnership,
  type WorkerOwnershipRow,
  type WorkerOwnershipTouch,
} from './worker-ownership-backfill.ts';

export type WorkRef = { adapter: string; id: string };
export type SkippedWork = WorkRef & { reason: 'weak' | 'claimed' };

export function reviewedWorkerOwnership(
  rows: readonly WorkerOwnershipRow[],
  touches: readonly WorkerOwnershipTouch[],
  reviewed: readonly WorkRef[]
) {
  const key = ({ adapter, id }: WorkRef) => JSON.stringify([adapter, id]);
  const candidates = new Map(
    inferWorkerOwnership(rows, touches).candidates.map((candidate) => [key(candidate), candidate])
  );
  const selected: WorkRef[] = [];
  const skipped: SkippedWork[] = [];
  const invalid: WorkRef[] = [];
  for (const ref of reviewed) {
    const candidate = candidates.get(key(ref));
    if (!candidate) invalid.push(ref);
    else if (candidate.evidence.claimedBy !== null) skipped.push({ ...ref, reason: 'claimed' });
    else if (!candidate.evidence.verbs.includes('start')) skipped.push({ ...ref, reason: 'weak' });
    else selected.push(ref);
  }
  return { selected, skipped, invalid };
}
