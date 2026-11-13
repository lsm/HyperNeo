import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoQuestion, NeoQuestionSource, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  NEO_WORKER_BLOCKER,
  neoDaemonCardDraft,
  planNeoRetriesCard,
} from '../../lib/neo/daemon-cards.ts';
import { openHumanCard, replaceHumanCard } from '../../lib/neo/human-card.ts';
import { neoTodoCovered } from '../../lib/neo/todo-state.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { ChangeRecorder } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';

type Input =
  | { kind: 'retries'; todoId: string; reason: string; now: number }
  | { kind: 'blocker'; todoId: string; source: NeoQuestionSource | null; now: number };

const openRetriesCard = (
  store: NeoAskTodoRepository,
  todo: NeoTodo,
  reason: string,
  now: number
) => {
  const blocked = store.updateTodo(
    todo,
    {
      state: 'blocked',
      blockedBy: 'failure',
      blockedReason: reason,
      nextAction: 'Waiting for the human to retry, mark it done, or remove it.',
    },
    now
  );
  const root = store.getAsk(todo.askId)?.parentId ?? todo.askId;
  const plan = planNeoRetriesCard(
    blocked,
    store.listFamilyTodos(todo.askId),
    store.familyQuestions(root)
  );
  if (!plan) return null;
  return plan.replaces
    ? replaceHumanCard(store, plan.replaces, crypto.randomUUID(), plan.draft, now)
    : openHumanCard(store, crypto.randomUUID(), root, plan.draft, now);
};

const openBlockerCard = (
  store: NeoAskTodoRepository,
  todo: NeoTodo,
  source: NeoQuestionSource | null,
  now: number
) => {
  if (neoTodoCovered(todo, store.todoCards(todo))) return null;
  const card = openHumanCard(
    store,
    crypto.randomUUID(),
    todo.askId,
    {
      ...neoDaemonCardDraft(NEO_WORKER_BLOCKER, [todo]),
      todoId: todo.id,
      document: todo.report,
      ...(source ? { sourceSession: source } : {}),
    },
    now
  );
  if (source) store.questionAnswers.bind(card.id, todo.id, source);
  return card;
};

const open = (superpipe({})('neo.daemonCard.open') as PipelineAPI)
  .input(['db', 'input', 'changes'])
  .pipe(
    (db: Database, changes: ChangeRecorder) =>
      new NeoAskTodoRepository(
        db,
        () => changes.notifyChange('neo_todos'),
        undefined,
        undefined,
        changes
      ),
    ['db', 'changes'],
    'store'
  )
  .pipe(
    (store: NeoAskTodoRepository, input: Input) => {
      const todo = store.getTodo(input.todoId);
      return todo && store.getAsk(todo.askId)?.status === 'open'
        ? { value: todo }
        : { reason: null };
    },
    ['store', 'input'],
    'result:card'
  )
  .pipe(
    (store: NeoAskTodoRepository, todo: NeoTodo, input: Input): NeoQuestion | null =>
      input.kind === 'retries'
        ? openRetriesCard(store, todo, input.reason, input.now)
        : openBlockerCard(store, todo, input.source, input.now),
    ['store', 'card', 'input'],
    'card'
  )
  .end('card') as (db: Database, input: Input, changes: ChangeRecorder) => NeoQuestion | null;

export const neoDaemonCardWrite = defineDbOp<Input, NeoQuestion | null>({
  name: 'neo.daemonCard.open',
  mode: 'write',
  run: (db, input, changes) => open(db, input, changes),
});
