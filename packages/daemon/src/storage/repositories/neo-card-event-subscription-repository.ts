import type { NeoCardEventSubscription } from '../../lib/neo/pack-contract.ts';
import type { Database } from '../sqlite-compat.ts';

export class NeoCardEventSubscriptionRepository {
  constructor(private readonly db: Database) {}

  subscribe(workId: string, topic: string, at: number): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO neo_card_event_subscriptions(work_id, topic, created_at) VALUES (?, ?, ?)
           ON CONFLICT(work_id, topic) DO UPDATE SET ended_at = NULL, created_at = excluded.created_at
           WHERE ended_at IS NOT NULL`
        )
        .run(workId, topic, at).changes > 0
    );
  }

  listActive(): NeoCardEventSubscription[] {
    return this.db
      .prepare(
        `SELECT work_id AS workId, topic FROM neo_card_event_subscriptions
          WHERE ended_at IS NULL ORDER BY created_at, rowid`
      )
      .all() as NeoCardEventSubscription[];
  }

  end(workId: string, topic: string, at: number): void {
    this.db
      .prepare(
        `UPDATE neo_card_event_subscriptions SET ended_at = ?
          WHERE work_id = ? AND topic = ? AND ended_at IS NULL`
      )
      .run(at, workId, topic);
  }
}
