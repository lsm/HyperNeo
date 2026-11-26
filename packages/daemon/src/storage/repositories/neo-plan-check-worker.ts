import type { NeoPlanCheck } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import { livePlanSteps, samePlanSteps } from '../../lib/neo/todo-follow-up.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { WorkDeliveryInputRepository } from './work-delivery-input-repository.ts';

class NeoPlanCheckWorker {
  constructor(private readonly db: Database) {}

  deliveries(ref: WorkRef) {
    return new WorkDeliveryInputRepository(this.db).list(ref);
  }

  record(todoId: string, check: Exclude<NeoPlanCheck, { legacy: true }>): boolean {
    return this.db.transaction(() => {
      const store = new NeoAskTodoRepository(this.db);
      const todo = store.getCheckable(todoId);
      if (
        !todo ||
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
  ['deliveries']
);
export const neoPlanCheckWrites = defineRepositoryOp(
  'neo.planCheckWrites',
  'write',
  NeoPlanCheckWorker,
  ['record']
);
