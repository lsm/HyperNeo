import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface WorkSessionRow {
  adapter: string;
  id: string;
  name: string;
  status: string;
}

class WorkSessionRepository {
  constructor(
    private readonly db: BunDatabase,
    private readonly reactiveDb?: ReactiveDatabase
  ) {}

  saveSessions(rows: readonly WorkSessionRow[], now: number): number {
    const save = this.db.prepare(`INSERT INTO work_sessions (adapter, id, name, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (adapter, id) DO UPDATE SET
        name = excluded.name, status = excluded.status, updated_at = excluded.updated_at
      WHERE name != excluded.name OR status != excluded.status`);
    const changed = this.db.transaction(() =>
      rows.reduce(
        (count, row) => count + save.run(row.adapter, row.id, row.name, row.status, now).changes,
        0
      )
    )();
    if (changed > 0) this.reactiveDb?.notifyChange('work_sessions');
    return changed;
  }
}

export const workSessionWrites = defineRepositoryOp(
  'workSessions.write',
  'write',
  WorkSessionRepository,
  ['saveSessions']
);
