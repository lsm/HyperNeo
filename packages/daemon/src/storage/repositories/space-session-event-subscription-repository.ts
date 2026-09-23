import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface SpaceSessionEventSubscription {
  id: string;
  spaceId: string;
  sessionId: string;
  topic: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SubscriptionRow {
  id: string;
  space_id: string;
  session_id: string;
  topic: string;
  label: string | null;
  created_at: number;
  updated_at: number;
}

function toSubscription(row: SubscriptionRow): SpaceSessionEventSubscription {
  return {
    id: row.id,
    spaceId: row.space_id,
    sessionId: row.session_id,
    topic: row.topic,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SpaceSessionEventSubscriptionRepository {
  constructor(private readonly db: BunDatabase) {}

  upsert(params: {
    spaceId: string;
    sessionId: string;
    topic: string;
    label?: string | null;
  }): SpaceSessionEventSubscription {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_session_event_subscriptions
          (id, space_id, session_id, topic, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, topic) DO UPDATE SET
           space_id = excluded.space_id,
           label = excluded.label,
           updated_at = excluded.updated_at`
      )
      .run(
        generateUUID(),
        params.spaceId,
        params.sessionId,
        params.topic,
        params.label ?? null,
        now,
        now
      );
    const row = this.db
      .prepare(`SELECT * FROM space_session_event_subscriptions WHERE session_id = ? AND topic = ?`)
      .get(params.sessionId, params.topic) as SubscriptionRow;
    return toSubscription(row);
  }

  get(id: string): SpaceSessionEventSubscription | null {
    const row = this.db
      .prepare(`SELECT * FROM space_session_event_subscriptions WHERE id = ?`)
      .get(id) as SubscriptionRow | null;
    return row ? toSubscription(row) : null;
  }

  listBySpace(spaceId: string): SpaceSessionEventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_session_event_subscriptions WHERE space_id = ? ORDER BY created_at, id`
      )
      .all(spaceId) as SubscriptionRow[];
    return rows.map(toSubscription);
  }
}
