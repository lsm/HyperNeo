import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { NeoTrackerMirror } from '../../lib/neo/tracker-mirror-plan.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';

export class NeoTrackerMirrorRepository {
  constructor(
    private readonly db: Database,
    private readonly changes?: Pick<ReactiveDatabase, 'notifyChange'>
  ) {}
  facts() {
    const mirrors = this.db
      .prepare(`SELECT owner_kind AS ownerKind, owner_id AS ownerId,
      tracker, home, ref, state, failures, updated_at AS updatedAt FROM neo_tracker_mirrors`)
      .all() as NeoTrackerMirror[];
    const store = new NeoAskTodoRepository(this.db);
    const asks = [
      ...new Map(
        [
          ...store.listOpenAsks(),
          ...mirrors.flatMap((row) =>
            row.ownerKind === 'ask' ? (store.getAsk(row.ownerId) ?? []) : []
          ),
        ].map((ask) => [ask.id, ask])
      ).values(),
    ];
    return { asks, todos: store.listTodosForAsks(asks.map((ask) => ask.id)), mirrors };
  }
  put(row: NeoTrackerMirror) {
    this.db
      .prepare(`INSERT INTO neo_tracker_mirrors VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_kind, owner_id, tracker) DO UPDATE SET
      ref=excluded.ref, state=excluded.state, failures=excluded.failures, updated_at=excluded.updated_at`)
      .run(
        row.ownerKind,
        row.ownerId,
        row.tracker,
        row.home,
        row.ref,
        row.state,
        row.failures,
        row.updatedAt
      );
    this.changes?.notifyChange('neo_tracker_mirrors');
  }
}
export const neoTrackerReads = defineRepositoryOp(
  'neo.tracker.read',
  'read',
  NeoTrackerMirrorRepository,
  ['facts']
);
export const neoTrackerWrites = defineRepositoryOp(
  'neo.tracker.write',
  'write',
  NeoTrackerMirrorRepository,
  ['put']
);
