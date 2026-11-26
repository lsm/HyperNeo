import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { NEO_CHECK_DEADLINE_MS } from '../daemon-cards.ts';

type Step = Pick<NeoTodo, 'state'> & { blockedBy?: NeoTodo['blockedBy'] };

export type NeoStepFacts = {
  todo: Step &
    Pick<NeoTodo, 'createdAt' | 'approvedAt' | 'startedAt' | 'finishedAt'> &
    Partial<Pick<NeoTodo, 'check' | 'instruction' | 'hold'>>;
  covered: boolean;
  held: boolean;
  prerequisites: readonly (Step & Pick<NeoTodo, 'finishedAt'> & { failedAt?: number | null })[];
  answerPending: boolean;
  cardClosedAt: number | null;
  failedAt: number | null;
  worker: { status: 'running' | 'idle' | 'unknown'; since: number } | null;
  packWaiting: boolean;
  start: 'held' | 'ready' | null;
  now: number;
};

export type NeoStepReason =
  | 'failed'
  | 'prerequisite_gone'
  | 'unanswered'
  | 'no_worker'
  | 'check_overdue'
  | 'idle_worker'
  | 'hold_failed'
  | 'hold_review';

export type NeoStepOwner =
  | { owner: 'human' | 'nobody' | 'prerequisite' | 'daemon' | 'worker' | 'pack' }
  | { owner: 'neo'; reason: NeoStepReason; since: number };

const failed = (todo: Step) => todo.state === 'blocked' && todo.blockedBy === 'failure';
const finished = (todo: Step) => todo.state === 'done';
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
  if (facts.held) {
    if (todo.hold?.failed) return neo('hold_failed', todo.hold.failed.at);
    if (todo.hold && facts.now >= todo.hold.reviewAt) return neo('hold_review', todo.hold.reviewAt);
    return { owner: 'nobody' };
  }
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
  const ready = prerequisites.map((item) => item.finishedAt);
  if (todo.check && !todo.instruction?.trim()) {
    const deadline = latest(todo.createdAt, ...ready) + NEO_CHECK_DEADLINE_MS;
    return facts.now < deadline ? { owner: 'daemon' } : neo('check_overdue', deadline);
  }
  return neo('no_worker', latest(began, ...ready));
}
