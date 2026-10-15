import type { Database } from '../sqlite-compat.ts';

const SEEDED = { askId: '', key: 'seeded' };

export class NeoNotificationTriggerRepository {
  private present: boolean | null = null;

  constructor(private readonly db: Database) {}

  private ready(): boolean {
    this.present ??= !!this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name = 'neo_notification_triggers' AND type = 'table'"
      )
      .get();
    return this.present;
  }

  told(askId: string): Set<string> {
    if (!this.ready()) return new Set();
    const rows = this.db
      .prepare('SELECT trigger_key AS key FROM neo_notification_triggers WHERE ask_id = ?')
      .all(askId) as { key: string }[];
    return new Set(rows.map((row) => row.key));
  }

  record(askId: string, keys: readonly string[], triggerId: string | null, at: number): void {
    if (!this.ready() || !keys.length) return;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO neo_notification_triggers
      (ask_id, trigger_key, trigger_id, created_at) VALUES (?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const key of keys) insert.run(askId, key, triggerId, at);
    })();
  }

  trigger(triggerId: string): { askId: string; keys: string[] } | null {
    if (!this.ready()) return null;
    const rows = this.db
      .prepare(
        'SELECT ask_id AS askId, trigger_key AS key FROM neo_notification_triggers WHERE trigger_id = ?'
      )
      .all(triggerId) as { askId: string; key: string }[];
    return rows.length ? { askId: rows[0].askId, keys: rows.map((row) => row.key) } : null;
  }

  outcomeTriggerIds(askId: string): string[] {
    if (!this.ready()) return [];
    return (
      this.db
        .prepare(`SELECT DISTINCT trigger_id AS triggerId FROM neo_notification_triggers
          WHERE ask_id = ? AND trigger_key LIKE 'outcome:%' AND trigger_id IS NOT NULL`)
        .all(askId) as { triggerId: string }[]
    ).map((row) => row.triggerId);
  }

  pending(since: number): { askId: string; triggerId: string }[] {
    if (!this.ready()) return [];
    return this.db
      .prepare(`SELECT DISTINCT ask_id AS askId, trigger_id AS triggerId
        FROM neo_notification_triggers WHERE trigger_id IS NOT NULL AND created_at > ?`)
      .all(since) as { askId: string; triggerId: string }[];
  }

  forget(askId: string, triggerId: string): void {
    if (!this.ready()) return;
    this.db
      .prepare('DELETE FROM neo_notification_triggers WHERE ask_id = ? AND trigger_id = ?')
      .run(askId, triggerId);
  }

  noteStatuses(sessionId: string, messageIds: readonly string[]): string[] {
    if (!messageIds.length) return [];
    const rows = this.db
      .prepare(`SELECT COALESCE(send_status, 'consumed') AS status FROM sdk_messages
        WHERE session_id = ? AND sdk_uuid IN (${messageIds.map(() => '?').join(', ')})`)
      .all(sessionId, ...messageIds) as { status: string }[];
    return rows.map((row) => row.status);
  }

  isSeeded(): boolean {
    return this.told(SEEDED.askId).has(SEEDED.key);
  }

  markSeeded(at: number): void {
    this.record(SEEDED.askId, [SEEDED.key], null, at);
  }
}
