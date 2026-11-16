import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

type Step = Pick<NeoTodo, 'state'> & { blockedBy?: NeoTodo['blockedBy'] };

export type NeoStepFacts = {
  todo: Step & Pick<NeoTodo, 'createdAt' | 'approvedAt' | 'startedAt' | 'finishedAt'>;
  covered: boolean;
  held: boolean;
  prerequisites: readonly (Step & Pick<NeoTodo, 'finishedAt'> & { failedAt?: number | null })[];
  answerPending: boolean;
  cardClosedAt: number | null;
  failedAt: number | null;
  worker: { status: 'running' | 'idle' | 'unknown'; since: number } | null;
  packWaiting: boolean;
  start: 'held' | 'ready' | null;
};

export type NeoStepReason =
  | 'failed'
  | 'prerequisite_gone'
  | 'unanswered'
  | 'no_worker'
  | 'idle_worker';

export type NeoStepOwner =
  | { owner: 'human' | 'nobody' | 'prerequisite' | 'daemon' | 'worker' | 'pack' }
  | { owner: 'neo'; reason: NeoStepReason; since: number };

const failed = (todo: Step) =>
  todo.state === 'failed' || (todo.state === 'blocked' && todo.blockedBy === 'failure');
const finished = (todo: Step) => todo.state === 'done' || todo.state === 'closed_unverified';
const latest = (...times: (number | null | undefined)[]) =>
  Math.max(...times.map((time) => time ?? 0));

export function nextStepOwner(facts: NeoStepFacts): NeoStepOwner {
  const { todo, prerequisites, worker } = facts;
  const began = latest(todo.createdAt, todo.approvedAt, todo.startedAt, todo.finishedAt);
  const neo = (reason: NeoStepReason, since: number): NeoStepOwner => ({
    owner: 'neo',
    reason,
    since,
  });
  if (facts.covered) return { owner: 'human' };
  if (facts.held) return { owner: 'nobody' };
  if (failed(todo)) return neo('failed', facts.failedAt ?? latest(began, worker?.since));
  const gone = prerequisites.filter((item) => item.state === 'removed' || failed(item));
  if (gone.length)
    return neo(
      'prerequisite_gone',
      latest(began, ...gone.map((item) => item.failedAt ?? item.finishedAt))
    );
  if (prerequisites.some((item) => !finished(item))) return { owner: 'prerequisite' };
  if (todo.state === 'blocked' && ['question', 'needs-human'].includes(todo.blockedBy ?? ''))
    return facts.answerPending
      ? { owner: 'daemon' }
      : neo('unanswered', facts.cardClosedAt ?? worker?.since ?? began);
  if (worker?.status === 'unknown') return { owner: 'daemon' };
  if (worker?.status === 'running') return { owner: 'worker' };
  if (facts.packWaiting) return { owner: 'pack' };
  if (worker) return neo('idle_worker', worker.since);
  if (facts.start) return { owner: 'daemon' };
  return neo('no_worker', latest(began, ...prerequisites.map((item) => item.finishedAt)));
}
