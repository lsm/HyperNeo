import type { RunningWork, WorkCandidate } from '../work-queue/capacity.ts';

type Facts = {
  candidates: readonly Pick<WorkCandidate, 'id' | 'worker'>[];
  running: readonly (RunningWork & { title?: string; reservation?: string | null })[];
};

const WAITING = 'Waiting for worker ';

export const isNeoTodoWorkerWait = (reason: string | null) => !!reason?.startsWith(WAITING);

export const neoTodoWorkerWait = (worker: string, title: string | undefined) =>
  `${WAITING}${worker}, which is working on ${title ? `"${title}"` : 'something outside a todo'}.`;

export const neoReservedWorkerWait = (worker: string, title: string, url: string) =>
  `${WAITING}${worker}, which is idle but kept by "${title}" while ${url} is open.`;

export function neoTodoWorkerWaitKey(reason: string | null) {
  const match = reason?.match(
    /^Waiting for worker (.+?), which is (?:working on .*|idle but kept by ".*" while (\S+) is open\.)$/s
  );
  return match ? JSON.stringify([match[1], match[2] ?? null]) : null;
}

export function planNeoTodoWaits(facts: Facts, busy: readonly string[]) {
  const taken = new Map(facts.running.flatMap((row) => (row.worker ? [[row.worker, row]] : [])));
  return {
    running: [...facts.running, ...busy.map((worker) => ({ group: null, worker, idle: true }))],
    waits: facts.candidates.map(({ id, worker }) => {
      const holder = worker ? taken.get(worker) : undefined;
      return {
        id,
        worker,
        reservation: holder?.reservation,
        reason:
          worker && (holder || busy.includes(worker))
            ? neoTodoWorkerWait(worker, holder?.title)
            : null,
      };
    }),
  };
}
