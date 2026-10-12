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

  isSeeded(): boolean {
    return this.told(SEEDED.askId).has(SEEDED.key);
  }

  markSeeded(at: number): void {
    this.record(SEEDED.askId, [SEEDED.key], null, at);
  }
}
