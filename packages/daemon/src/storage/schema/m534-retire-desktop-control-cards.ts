import type { Database } from '../sqlite-compat.ts';

export function runMigration534(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'desktop_app')) return;
  db.exec(`UPDATE neo_questions
    SET state = 'retired',
      retired_reason = 'desktop_card_removed: the Mac now asks once per app; nothing was granted.'
    WHERE desktop_app IS NOT NULL AND state = 'open'`);
}
