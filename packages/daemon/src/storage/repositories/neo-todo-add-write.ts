import superpipe, { type PipelineAPI } from 'superpipe';
import type { z } from 'zod';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoTodoPolicies } from '../../lib/neo/packs/todo-policies.ts';
import { type NeoTodoDraftSchema, planNeoTodoDraft } from '../../lib/neo/todo-operations.ts';
import { neoTodoHome, neoTodoRepo } from '../../lib/neo/todo-repo.ts';
import { planNeoTodoAwaitingStart } from '../../lib/neo/todo-runner.ts';
import { ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

type Input = {
  askId: string;
  todoId: string;
  draft: z.infer<typeof NeoTodoDraftSchema>;
  split: boolean;
  now: number;
};
type Receipt =
  | { ok: false; reason: string }
  | { ok: true; todo?: NeoTodo; start?: string; records?: string[] };
type Plan = {
  ask: NeoAsk;
  repo: string | null;
  split: boolean;
  draft: Input['draft'] & { doneWhen: string; records?: string[] };
};

const add = (superpipe({})('neo.todo.commit-add') as PipelineAPI)
  .input(['db', 'input', 'changes'])
  .pipe(
    (db: Database, changes: ChangeRecorder) =>
      new NeoAskTodoRepository(
        db,
        () => {
          changes.notifyChange('neo_asks');
          changes.notifyChange('neo_todos');
        },
        undefined,
        () => changes.notifyChange('neo_questions')
      ),
    ['db', 'changes'],
    'store'
  )
  .pipe(
    (
      db: Database,
      store: NeoAskTodoRepository,
      input: Input
    ): { value: Plan } | { reason: Receipt } => {
      const ask = store.getAsk(input.askId);
      if (!ask) return { reason: { ok: false, reason: 'not_found: no such ask.' } };
      if (ask.status !== 'open')
        return {
          reason: {
            ok: true,
            records: [`ask_settled: this ask is ${ask.status}; no change was made.`],
          },
        };
      const policies = neoTodoPolicies(db);
      const planned = planNeoTodoDraft(input.draft, policies);
      if ('reason' in planned) return planned;
      const repo = neoTodoRepo(input.draft, policies, ask);
      const split = input.split || store.listChildAsks(ask.id).length > 0;
      const home =
        !repo || ask.repo === repo || (!split && !ask.repo) ? ask : store.childAsk(ask.id, repo);
      if (home && home.status !== 'open')
        return {
          reason: {
            ok: true,
            records: [`ask_settled: ${home.title} is settled; nothing was added.`],
          },
        };
      const accepted = planNeoTodoDraft(
        input.draft,
        policies,
        home ? store.listTodos(home.id) : []
      );
      return 'reason' in accepted
        ? accepted
        : { value: { ask, repo, split, draft: accepted.value } };
    },
    ['db', 'store', 'input'],
    'result:outcome'
  )
  .pipe(
    (
      db: Database,
      store: NeoAskTodoRepository,
      input: Input,
      plan: Plan,
      changes: ChangeRecorder
    ): Receipt => {
      const { draft } = plan;
      const home = neoTodoHome(store, plan.ask, plan.repo, plan.split);
      let todo = store.addTodo(input.todoId, home.id, draft, input.now, plan.repo);
      if (draft.target) new NeoTodoSessionRepository(db).create(todo.id, draft.target);
      if (!draft.start && todo.instruction) {
        store.joinStartQuestion(todo, input.now);
        changes.notifyChange('neo_questions');
        const blocked = planNeoTodoAwaitingStart(todo);
        if (blocked) todo = store.updateTodo(todo, blocked, input.now);
      }
      if (draft.target) changes.notifyChange('neo_todo_sessions');
      return {
        ok: true,
        todo,
        ...(draft.start ? { start: todo.id } : {}),
        ...(draft.records ? { records: draft.records } : {}),
      };
    },
    ['db', 'store', 'input', 'outcome', 'changes'],
    'outcome'
  )
  .end('outcome') as (db: Database, input: Input, changes: ChangeRecorder) => Receipt;

export const neoTodoAddWrites = defineDbOp({ name: 'neo.todoAddWrites', mode: 'write', run: add });
