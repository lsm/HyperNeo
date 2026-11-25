import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkRef, WorkSummary } from './types.ts';

export interface WorkerReuseFacts {
  sameAskAt: number | null;
  settledAt: number | null;
}

export interface WorkerReuseCandidate extends WorkerReuseFacts {
  work: WorkSummary;
  free: boolean;
}

type ReuseRequest = {
  adapter: string;
  folder: string;
  refreshStatus: boolean;
  roleWorker?: string;
  excludeRefs?: readonly WorkRef[];
};

type ReuseDecision =
  | { action: 'send'; candidate: WorkerReuseCandidate }
  | { action: 'wait'; candidate: WorkerReuseCandidate; role: boolean }
  | { action: 'start' };

export function chooseReusableWorker(
  candidates: readonly WorkerReuseCandidate[],
  request: ReuseRequest
): WorkerReuseCandidate | undefined {
  return candidates
    .filter(
      ({ work, free }) =>
        free &&
        work.ref.adapter === request.adapter &&
        !work.ref.daemon &&
        (work.place.folder === request.folder || work.ref.id === request.roleWorker) &&
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

function decideReuse(
  candidates: readonly WorkerReuseCandidate[],
  sameAskCandidates: readonly WorkerReuseCandidate[],
  request: ReuseRequest,
  sameAsk: readonly string[],
  busyRole: WorkerReuseCandidate | null
): ReuseDecision {
  if (busyRole) return { action: 'wait', candidate: busyRole, role: true };
  const candidate = chooseReusableWorker(candidates, request);
  if (candidate) return { action: 'send', candidate };
  const busy = sameAskCandidates.find(
    ({ work, free }) =>
      sameAsk.includes(work.ref.id) &&
      work.ref.adapter === request.adapter &&
      !work.ref.daemon &&
      work.place.folder === request.folder &&
      !request.excludeRefs?.some(
        (ref) =>
          ref.adapter === work.ref.adapter &&
          ref.id === work.ref.id &&
          ref.daemon === work.ref.daemon
      ) &&
      (work.status === 'running' || work.status === 'queued' || (!free && work.status === 'done'))
  );
  return busy ? { action: 'wait', candidate: busy, role: false } : { action: 'start' };
}

export const reuseWorkerDecision = (superpipe({})('work-start-reuse-decision') as PipelineAPI)
  .input(['candidates', 'sameAskCandidates', 'request', 'sameAsk', 'busyRole'])
  .pipe(
    decideReuse,
    ['candidates', 'sameAskCandidates', 'request', 'sameAsk', 'busyRole'],
    'decision'
  )
  .end('decision') as (
  candidates: readonly WorkerReuseCandidate[],
  sameAskCandidates: readonly WorkerReuseCandidate[],
  request: ReuseRequest,
  sameAsk: readonly string[],
  busyRole: WorkerReuseCandidate | null
) => ReuseDecision;
export function matchingPreparation(
  stored: string | null,
  requested: { pack: string; parameters: Record<string, unknown>; sandbox?: boolean } | undefined,
  perRoundFields: readonly string[]
): boolean {
  if (!stored || !requested) return !stored && !requested;
  const prior = JSON.parse(stored) as typeof requested;
  if (prior.pack !== requested.pack || prior.sandbox !== requested.sandbox) return false;
  const stable = (parameters: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(parameters).filter(([key]) => !perRoundFields.includes(key)));
  return isDeepStrictEqual(stable(prior.parameters), stable(requested.parameters));
}
