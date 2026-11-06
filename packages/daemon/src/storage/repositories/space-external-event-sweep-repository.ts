import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const EXTERNAL_EVENT_TABLES = ['space_external_events', 'space_external_event_deliveries'] as const;

class SpaceExternalEventSweepRepository {
  constructor(
    private readonly db: BunDatabase,
    private readonly reactiveDb?: ReactiveDatabase
  ) {}

  private notify(tables: readonly string[] = EXTERNAL_EVENT_TABLES): void {
    if (!this.reactiveDb) return;
    for (const table of tables) this.reactiveDb.notifyChange(table);
  }

  markPublishedEventsFailedBefore(createdAtBefore: number, now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE space_external_events
         SET state = 'failed', updated_at = ?
         WHERE state = 'published'
           AND created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM space_external_event_deliveries d WHERE d.event_id = space_external_events.id
           )`
      )
      .run(now, createdAtBefore);
    if (result.changes > 0) this.notify(['space_external_events']);
    return result.changes ?? 0;
  }

  markPendingDeliveriesFailedBefore(
    createdAtBefore: number,
    skipDeliveryKeys: ReadonlySet<string>,
    now: number = Date.now()
  ): Array<{ eventId: string; deliveryKey: string }> {
    const skip = [...skipDeliveryKeys];
    const skipClause =
      skip.length > 0 ? `AND delivery_key NOT IN (${skip.map(() => '?').join(',')})` : '';
    const expired = this.db
      .prepare(
        `UPDATE space_external_event_deliveries
         SET state = 'failed', failure_reason = 'ttl_expired', updated_at = ?
         WHERE state = 'pending'
           AND EXISTS (
             SELECT 1 FROM space_external_events e
             WHERE e.id = space_external_event_deliveries.event_id
               AND e.created_at < ?
           )
           ${skipClause}
         RETURNING event_id, delivery_key`
      )
      .all(now, createdAtBefore, ...skip) as Array<{ event_id: string; delivery_key: string }>;
    if (expired.length > 0) this.notify();

    const rollup = this.db
      .prepare(
        `UPDATE space_external_events
         SET state = 'failed', updated_at = ?
         WHERE state = 'published'
           AND EXISTS (
             SELECT 1 FROM space_external_event_deliveries d
             WHERE d.event_id = space_external_events.id
               AND d.state = 'failed' AND d.failure_reason = 'ttl_expired'
           )
           AND NOT EXISTS (
             SELECT 1 FROM space_external_event_deliveries d
             WHERE d.event_id = space_external_events.id AND d.state = 'pending'
           )`
      )
      .run(now);
    if (expired.length === 0 && rollup.changes > 0) this.notify(['space_external_events']);
    return expired.map((row) => ({ eventId: row.event_id, deliveryKey: row.delivery_key }));
  }
}

export const externalEventSweeps = defineRepositoryOp(
  'externalEvents.sweep',
  'write',
  SpaceExternalEventSweepRepository,
  ['markPublishedEventsFailedBefore', 'markPendingDeliveriesFailedBefore']
);
