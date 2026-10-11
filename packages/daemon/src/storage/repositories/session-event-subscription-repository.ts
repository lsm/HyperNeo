import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface SessionEventSubscription {
  sessionId: string;
  topic: string;
  label: string | null;
  createdAt: number;
}

interface SubscriptionRow {
  session_id: string;
  topic: string;
  label: string | null;
  created_at: number;
}

function toSubscription(row: SubscriptionRow): SessionEventSubscription {
  return {
    sessionId: row.session_id,
    topic: row.topic,
    label: row.label,
    createdAt: row.created_at,
  };
}

export class SessionEventSubscriptionRepository {
  constructor(private readonly db: BunDatabase) {}

  upsert(params: { sessionId: string; topic: string; label?: string | null }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_event_subscriptions
          (id, session_id, topic, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, topic) DO UPDATE SET
           label = excluded.label,
           updated_at = excluded.updated_at`
      )
      .run(generateUUID(), params.sessionId, params.topic, params.label ?? null, now, now);
  }

  listBySession(sessionId: string): SessionEventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, topic, label, created_at FROM session_event_subscriptions
          WHERE session_id = ? ORDER BY created_at, rowid`
      )
      .all(sessionId) as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  referencesRepo(owner: string, repo: string): boolean {
    const escape = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
    return !!this.db
      .prepare(`SELECT 1 FROM session_event_subscriptions WHERE topic LIKE ? ESCAPE '\\' LIMIT 1`)
      .get(`github/${escape(owner)}/${escape(repo)}/%`);
  }

  listAll(): SessionEventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, topic, label, created_at FROM session_event_subscriptions
          ORDER BY created_at, rowid`
      )
      .all() as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  delete(sessionId: string, topic: string): void {
    this.db
      .prepare(`DELETE FROM session_event_subscriptions WHERE session_id = ? AND topic = ?`)
      .run(sessionId, topic);
  }
}
