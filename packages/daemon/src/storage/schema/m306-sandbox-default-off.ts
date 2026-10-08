import type { Database } from '../sqlite-compat.ts';

export function runMigration306(db: Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'global_settings' AND type = 'table'")
    .get();
  if (!table) return;
  const row = db.prepare('SELECT settings FROM global_settings WHERE id = 1').get() as
    | { settings: string }
    | undefined;
  if (!row) return;
  let settings: { sandbox?: { enabled?: boolean } };
  try {
    settings = JSON.parse(row.settings);
  } catch {
    return;
  }
  if (settings.sandbox?.enabled !== true) return;
  settings.sandbox.enabled = false;
  db.prepare(
    "UPDATE global_settings SET settings = ?, updated_at = datetime('now') WHERE id = 1"
  ).run(JSON.stringify(settings));
}
