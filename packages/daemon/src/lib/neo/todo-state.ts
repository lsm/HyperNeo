import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoJudgement } from './pack-contract.ts';

export interface TodoStateFacts {
  todo: NeoTodo;
  order: readonly Pick<NeoTodo, 'id' | 'state' | 'startedAt'>[];
  askOpen: boolean;
  questionOpen: boolean;
  dispatched: boolean;
  live: string | null;
  change: NeoTodoPatch;
  judgement: NeoTodoJudgement;
}

export interface TodoStateDecision {
  patch: NeoTodoPatch;
  startNext: string | null;
}

export function decideTodoState(facts: TodoStateFacts, now: number): TodoStateDecision {
  const { todo, judgement, change } = facts;
  if (todo.state === 'removed') return { patch: {}, startNext: null };
  let patch = { ...change };
  if (!facts.askOpen && ['todo', 'doing', 'blocked'].includes(todo.state))
    patch = { ...patch, state: 'removed', finishedAt: now };
  if (patch.state !== 'removed') {
    if (judgement.state === 'done')
      patch = {
        ...patch,
        state: 'done',
        evidence: judgement.evidence,
        finishedAt: todo.finishedAt ?? now,
      };
    else if (judgement.state === 'failed')
      patch = {
        ...patch,
        state: 'failed',
        reason: judgement.reason,
        finishedAt: todo.finishedAt ?? now,
      };
    else if (judgement.state === 'blocked')
      patch = {
        ...patch,
        state: 'blocked',
        blockedBy: 'check',
        blockedReason: judgement.reason,
        nextAction: judgement.reason,
      };
    else if (!Object.keys(change).length && !['done', 'failed'].includes(todo.state)) {
      if (
        facts.questionOpen &&
        !facts.dispatched &&
        (todo.state === 'todo' || todo.blockedBy === 'question')
      )
        patch = {
          ...patch,
          state: 'blocked',
          blockedBy: 'question',
          blockedReason: 'Waiting for the human to answer.',
          nextAction: 'Answer the question.',
        };
      else if (facts.live === 'failed' || facts.live === 'needs_you')
        patch = {
          ...patch,
          state: 'blocked',
          blockedBy: 'worker',
          blockedReason: `Its session is ${facts.live}.`,
          nextAction: 'Resolve the session blocker.',
        };
      else if (
        todo.state !== 'blocked' ||
        todo.blockedBy === 'question' ||
        todo.blockedBy === 'check'
      )
        patch.state = facts.dispatched ? 'doing' : 'todo';
    }
  }
  const state = patch.state ?? todo.state;
  if (patch.state && state !== 'blocked')
    patch = { ...patch, blockedBy: null, blockedReason: null, nextAction: null };
  if (!Object.keys(change).length)
    patch = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => value !== todo[key as keyof NeoTodo])
    ) as NeoTodoPatch;
  const next =
    facts.askOpen && state === 'done'
      ? facts.order.find((row) => row.id !== todo.id && !['done', 'removed'].includes(row.state))
      : null;
  return { patch, startNext: next?.state === 'todo' && next.startedAt === null ? next.id : null };
}

const recompute = (superpipe({})('neo.todo.recompute') as PipelineAPI)
  .input(['read', 'write', 'now'])
  .pipe((read: () => TodoStateFacts) => read(), 'read', 'facts')
  .pipe(decideTodoState, ['facts', 'now'], 'decision')
  .pipe(
    (write: (decision: TodoStateDecision) => unknown, decision: TodoStateDecision) =>
      write(decision),
    ['write', 'decision'],
    'written'
  );

export const recomputeTodoState = recompute.end('written') as <T>(
  read: () => TodoStateFacts,
  write: (decision: TodoStateDecision) => T,
  now: number
) => T;

export const recomputeTodoStateAsync = recompute.endAsync('written') as <T>(
  read: () => TodoStateFacts,
  write: (decision: TodoStateDecision) => Promise<T>,
  now: number
) => Promise<T>;
