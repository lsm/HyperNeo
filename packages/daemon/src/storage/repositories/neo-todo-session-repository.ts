import type { WorkRef } from '../../lib/drivers/types.ts';
import type { NeoDriverTarget } from '../../lib/neo/driver-work.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoDriverSessionRows } from './neo-driver-session-rows.ts';

export class NeoTodoSessionRepository extends NeoDriverSessionRows {
  constructor(db: Database) {
    super(db, 'neo_todo_sessions', 'todo_id');
  }

  create(todoId: string, target: NeoDriverTarget): void {
    this.db
      .prepare('INSERT OR IGNORE INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)')
      .run(todoId, JSON.stringify(target));
  }

  awaitingReports(): { todoId: string; ref: WorkRef }[] {
    return (
      this.db
        .prepare(
          `SELECT s.todo_id AS todoId, s.ref FROM neo_todo_sessions s
             JOIN neo_todos t ON t.id = s.todo_id
            WHERE s.ref IS NOT NULL AND t.state = 'doing' AND t.report IS NULL`
        )
        .all() as { todoId: string; ref: string }[]
    ).map((row) => ({ todoId: row.todoId, ref: JSON.parse(row.ref) as WorkRef }));
  }
}
