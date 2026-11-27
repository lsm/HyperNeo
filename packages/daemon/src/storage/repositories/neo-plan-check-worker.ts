import type { NeoPlanCheck } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import { livePlanSteps, samePlanSteps } from '../../lib/neo/todo-follow-up.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { readTodoRoles } from './work-started-sessions-worker.ts';
import { WorkDeliveryInputRepository } from './work-delivery-input-repository.ts';

class NeoPlanCheckWorker {
  constructor(private readonly db: Database) {}

  deliveries(ref: WorkRef) {
    return new WorkDeliveryInputRepository(this.db).list(ref);
  }

  doer(todoId: string): { ref: WorkRef; model?: string | null } | null {
    const local = readTodoRoles(this.db, todoId).find(({ role }) => role === 'do');
    const remote = new WorkDeliveryInputRepository(this.db)
      .list(todoId)
      .findLast(
        ({ target, outcome, observedAt }) =>
          target.verb === 'start' &&
          target.role === 'do' &&
          outcome &&
          'ref' in outcome &&
          outcome.ref.daemon &&
          (observedAt ?? 0) >= (local?.at ?? 0)
      )?.outcome;
    if (remote && 'ref' in remote) return { ref: remote.ref, model: remote.model };
    return local ? { ref: { id: local.id, adapter: local.adapter }, model: local.model } : null;
  }

  record(todoId: string, check: Exclude<NeoPlanCheck, { legacy: true }>): boolean {
    return this.db.transaction(() => {
      const store = new NeoAskTodoRepository(this.db);
      const todo = store.getCheckable(todoId);
      if (
        !todo ||
        !check.stepIds.length ||
        !samePlanSteps(check.stepIds, livePlanSteps(todo.id, store.listFamilyTodos(todo.askId)))
      )
        return false;
      return (
        this.db
          .prepare('UPDATE neo_todos SET plan_check_json = ? WHERE id = ?')
          .run(JSON.stringify(check), todoId).changes === 1
      );
    })();
  }
}

export const neoPlanCheckReads = defineRepositoryOp(
  'neo.planCheckReads',
  'read',
  NeoPlanCheckWorker,
  ['deliveries', 'doer']
);
export const neoPlanCheckWrites = defineRepositoryOp(
  'neo.planCheckWrites',
  'write',
  NeoPlanCheckWorker,
  ['record']
);
