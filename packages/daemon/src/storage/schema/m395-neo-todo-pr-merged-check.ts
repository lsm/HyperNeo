import type { Database } from '../sqlite-compat.ts';

export function runMigration395(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'neo_todos'").get())
    return;
  db.exec(`UPDATE neo_todos SET check_json = json_set(check_json, '$.kind', 'pr_merged')
    WHERE json_valid(check_json) AND json_extract(check_json, '$.pack') = 'coding'
      AND json_extract(check_json, '$.kind') = 'pr_opened'`);
}
