import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoJudgement } from './pack-contract.ts';

export interface TodoStateFacts {
  todo: NeoTodo;
  order: readonly (Pick<NeoTodo, 'id' | 'state' | 'startedAt'> & { questionOpen?: number })[];
  askOpen: boolean;
  questionOpen: boolean;
  answerPending?: boolean;
  triagePending?: boolean;
  dispatched: boolean;
  live: string | null;
  change: NeoTodoPatch;
  judgement: NeoTodoJudgement;
}

export const NEO_TODO_STALLED_CARD_TAIL =
  ' has nobody working on it, and HyperNeo cannot restart it on its own. Where should it continue, or should it close?';

export const neoTodoStalledCard = (todo: Pick<NeoTodo, 'title'>) =>
  `"${todo.title}"${NEO_TODO_STALLED_CARD_TAIL}`;

export const isNeoTodoStalledCard = (text: string) => text.endsWith(NEO_TODO_STALLED_CARD_TAIL);

export function neoTodoAwaitsHuman(
  todo: Pick<NeoTodo, 'id'>,
  questions: readonly Pick<NeoQuestion, 'state' | 'todoId' | 'kind' | 'startTodos' | 'text'>[]
): boolean {
  return questions.some(
    (question) =>
      question.state === 'open' &&
      !isNeoTodoStalledCard(question.text) &&
      (!question.todoId || question.todoId === todo.id) &&
      (question.kind !== 'start' || !!question.startTodos?.includes(todo.id))
  );
}

export interface TodoStateDecision {
  patch: NeoTodoPatch;
  startNext: string | null;
}

export function decideTodoState(facts: TodoStateFacts, now: number): TodoStateDecision {
  const { todo, judgement, change } = facts;
  if (todo.state === 'removed') return { patch: {}, startNext: null };
  if (
    todo.blockedBy === 'needs-human' &&
    judgement.state !== 'done' &&
    change.state !== 'removed' &&
    facts.askOpen &&
    (facts.questionOpen ||
      facts.answerPending ||
      (facts.triagePending && !Object.keys(change).length))
  )
    return {
      patch: Object.fromEntries(
        Object.entries({
          ...change,
          state: 'blocked',
          blockedBy: 'needs-human',
          blockedReason: todo.blockedReason,
          nextAction: todo.nextAction,
        }).filter(
          ([key, value]) => Object.keys(change).length || value !== todo[key as keyof NeoTodo]
        )
      ) as NeoTodoPatch,
      startNext: null,
    };
  let patch = { ...change };
  if (!facts.askOpen && ['todo', 'doing', 'blocked'].includes(todo.state))
    patch = { ...patch, state: 'removed', finishedAt: now };
  const held = todo.blockedBy === 'held' && !Object.keys(change).length;
  if (patch.state !== 'removed') {
    if (judgement.state === 'done')
      patch = {
        ...patch,
        state: 'done',
        evidence: judgement.evidence,
        finishedAt: todo.finishedAt ?? now,
      };
    else if (judgement.state === 'failed' && !held)
      patch = {
        ...patch,
        state: 'failed',
        reason: judgement.reason,
        finishedAt: todo.finishedAt ?? now,
      };
    else if (judgement.state === 'blocked' && !held)
      patch = {
        ...patch,
        state: 'blocked',
        blockedBy: 'check',
        blockedReason: judgement.reason,
        nextAction: judgement.reason,
      };
    else if (
      !Object.keys(change).length &&
      !['done', 'closed_unverified', 'failed'].includes(todo.state) &&
      !(
        todo.state === 'blocked' &&
        ['failure', 'stalled', 'held', 'check', 'environment'].includes(todo.blockedBy ?? '')
      )
    ) {
      if (
        facts.questionOpen &&
        (todo.blockedBy === 'question' ||
          (facts.dispatched
            ? todo.state === 'doing' && ['done', 'stopped'].includes(facts.live ?? '')
            : todo.state === 'todo'))
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
      else patch.state = facts.dispatched ? 'doing' : 'todo';
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
    facts.askOpen && ['done', 'closed_unverified'].includes(state)
      ? facts.order.find(
          (row) =>
            row.id !== todo.id && !['done', 'closed_unverified', 'removed'].includes(row.state)
        )
      : null;
  return {
    patch,
    startNext:
      next?.state === 'todo' && next.startedAt === null && !next.questionOpen ? next.id : null,
  };
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
