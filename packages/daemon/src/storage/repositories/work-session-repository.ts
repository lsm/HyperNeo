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
    const { changes } = this.db
      .prepare(
        `INSERT INTO work_sessions (adapter, id, name, status, updated_at)
         SELECT value ->> 'adapter', value ->> 'id', value ->> 'name', value ->> 'status', ?2
         FROM json_each(?1) WHERE true
         ON CONFLICT (adapter, id) DO UPDATE SET
           name = excluded.name, status = excluded.status, updated_at = excluded.updated_at
         WHERE name != excluded.name OR status != excluded.status`
      )
      .run(JSON.stringify(rows), now);
    if (changes > 0) this.reactiveDb?.notifyChange('work_sessions');
    return changes;
  }
}

export const workSessionWrites = defineRepositoryOp(
  'workSessions.write',
  'write',
  WorkSessionRepository,
  ['saveSessions']
);
