import type { RunningWork, WorkCandidate } from '../work-queue/capacity.ts';

type Facts = {
  candidates: readonly Pick<WorkCandidate, 'id' | 'worker'>[];
  running: readonly (RunningWork & { title?: string })[];
};

const WAITING = 'Waiting for worker ';

export const isNeoTodoWorkerWait = (reason: string | null) => !!reason?.startsWith(WAITING);

export const neoTodoWorkerWait = (worker: string, title: string | undefined) =>
  `${WAITING}${worker}, which is working on ${title ? `"${title}"` : 'something outside a todo'}.`;

export function planNeoTodoWaits(facts: Facts, busy: readonly string[]) {
  const taken = new Map(
    facts.running.flatMap((row) => (row.worker ? [[row.worker, row.title]] : []))
  );
  const waits = (worker: string | null) => !!worker && (taken.has(worker) || busy.includes(worker));
  return {
    running: [...facts.running, ...busy.map((worker) => ({ group: null, worker, idle: true }))],
    waits: facts.candidates.map(({ id, worker }) => ({
      id,
      reason: worker && waits(worker) ? neoTodoWorkerWait(worker, taken.get(worker)) : null,
    })),
  };
}
