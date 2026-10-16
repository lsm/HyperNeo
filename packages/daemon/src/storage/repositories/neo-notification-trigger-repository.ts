import type { Database } from '../sqlite-compat.ts';

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

  record(askId: string, keys: readonly string[], triggerId: string | null, at: number): void {
    if (!this.ready() || !keys.length) return;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO neo_notification_triggers
      (ask_id, trigger_key, trigger_id, created_at) VALUES (?, ?, ?, ?)`);
    insert.run(askId, JSON.stringify({ id: triggerId, keys: [...keys].sort() }), triggerId, at);
  }

  trigger(triggerId: string): { askId: string; keys: string[] } | null {
    if (!this.ready()) return null;
    const rows = this.db
      .prepare(
        'SELECT ask_id AS askId, trigger_key AS key FROM neo_notification_triggers WHERE trigger_id = ?'
      )
      .all(triggerId) as { askId: string; key: string }[];
    return rows.length
      ? { askId: rows[0].askId, keys: rows.flatMap((row) => readTriggerKeys(row.key)) }
      : null;
  }

  triggerIdsFor(askId: string, key: string): string[] {
    if (!this.ready()) return [];
    const rows = this.db
      .prepare(
        'SELECT trigger_id AS triggerId, trigger_key AS key FROM neo_notification_triggers WHERE ask_id = ? AND trigger_id IS NOT NULL'
      )
      .all(askId) as { triggerId: string; key: string }[];
    return [
      ...new Set(
        rows
          .filter((row) =>
            readTriggerKeys(row.key).some((item) => item === key || item.startsWith(`${key}:q`))
          )
          .map((row) => row.triggerId)
      ),
    ];
  }
}

function readTriggerKeys(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(key);
    const keys = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && 'keys' in parsed
        ? parsed.keys
        : null;
    if (Array.isArray(keys) && keys.every((item) => typeof item === 'string')) return keys;
  } catch {}
  return [key];
}
