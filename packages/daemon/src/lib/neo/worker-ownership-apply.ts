import { createHash } from 'node:crypto';
import {
  inferWorkerOwnership,
  type WorkerOwnershipRow,
  type WorkerOwnershipTouch,
} from './worker-ownership-backfill.ts';

export type WorkRef = { adapter: string; id: string };

export function reviewedWorkerOwnership(
  rows: readonly WorkerOwnershipRow[],
  touches: readonly WorkerOwnershipTouch[],
  reviewed: readonly WorkRef[]
): WorkRef[] {
  const listed = new Set(reviewed.map(({ adapter, id }) => JSON.stringify([adapter, id])));
  return inferWorkerOwnership(rows, touches)
    .candidates.filter(
      ({ adapter, id, evidence }) =>
        listed.has(JSON.stringify([adapter, id])) &&
        evidence.claimedBy === null &&
        evidence.verbs.includes('start')
    )
    .map(({ adapter, id }) => ({ adapter, id }));
}

export function reviewedWorkerListId(reviewed: readonly WorkRef[]): string {
  const canonical = reviewed
    .map(({ adapter, id }) => [adapter, id])
    .sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
