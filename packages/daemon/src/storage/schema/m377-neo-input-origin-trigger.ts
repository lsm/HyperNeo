import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name);

export function runMigration377(db: Database): void {
  if (!hasTable(db, 'neo_input_origins')) return;
  const columns = db.prepare('PRAGMA table_info(neo_input_origins)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'trigger_id')) return;
  db.exec('ALTER TABLE neo_input_origins ADD COLUMN trigger_id TEXT');
  db.exec(`UPDATE neo_input_origins SET trigger_id = CASE
      WHEN instr(substr(message_id, 13), '#') > 0
        THEN substr(message_id, 13, instr(substr(message_id, 13), '#') - 1)
      ELSE substr(message_id, 13) END
    WHERE message_id LIKE 'neo-trigger:%'`);
  db.exec(`UPDATE neo_input_origins SET trigger_id = 'human:' || origin_message_id
    WHERE message_id LIKE 'neo-nudge:%' OR message_id LIKE 'neo-forward:%'
      OR message_id LIKE 'neo-cross-project:%:reply'`);
  const consultations = hasTable(db, 'neo_consultations')
    ? (db.prepare('PRAGMA table_info(neo_consultations)').all() as { name: string }[])
    : [];
  if (!consultations.some((column) => column.name === 'origin_message_id')) return;
  db.exec(`UPDATE neo_input_origins SET trigger_id = (
      SELECT CASE
        WHEN c.origin_message_id = neo_input_origins.origin_message_id
          THEN 'human:' || c.origin_message_id
        WHEN c.origin_message_id LIKE 'neo-trigger:%' AND instr(substr(c.origin_message_id, 13), '#') > 0
          THEN substr(c.origin_message_id, 13, instr(substr(c.origin_message_id, 13), '#') - 1)
        WHEN c.origin_message_id LIKE 'neo-trigger:%' THEN substr(c.origin_message_id, 13)
      END
      FROM neo_consultations c
      WHERE neo_input_origins.message_id IN ('neo-consult:' || c.id || ':request', 'neo-consult:' || c.id || ':reply'))
    WHERE message_id LIKE 'neo-consult:%'`);
}
