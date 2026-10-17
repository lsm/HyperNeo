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

  readLink(todoId: string): string | null {
    const row = this.db
      .prepare('SELECT ref, link, remote_link AS remote FROM neo_todo_sessions WHERE todo_id = ?')
      .get(todoId) as { ref: string | null; link: string | null; remote: string | null } | null;
    const ref = row?.ref ? (JSON.parse(row.ref) as WorkRef) : null;
    const local = row?.link && !(ref?.daemon && row.link.startsWith('/')) ? row.link : null;
    return (
      local ??
      row?.remote ??
      (ref?.adapter === 'hyperneo' && !ref.daemon ? `/session/${ref.id}` : null)
    );
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
