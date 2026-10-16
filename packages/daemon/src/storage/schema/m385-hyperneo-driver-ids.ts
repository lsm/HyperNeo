import type { Database } from '../sqlite-compat.ts';

export function runMigration385(db: Database): void {
  const fields = [
    ['neo_work_driver_targets', 'target', '$.adapter'],
    ['neo_work_driver_targets', 'target', '$.ref.adapter'],
    ['neo_work_driver_targets', 'ref', '$.adapter'],
    ['neo_work_refusals', 'ref', '$.adapter'],
  ];
  for (const [table, column, path] of fields) {
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table))
      continue;
    db.prepare(`UPDATE ${table} SET ${column} = json_set(${column}, ?,
      CASE json_extract(${column}, ?) WHEN 'hyperneo' THEN 'hyperneo-sessions'
        WHEN 'space' THEN 'hyperneo-spaces' END)
      WHERE CASE WHEN json_valid(${column}) THEN json_extract(${column}, ?) END
        IN ('hyperneo', 'space')`).run(path, path, path);
  }
  const columns = db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === 'sent_receipt')) return;
  for (const [oldId, newId] of [
    ['hyperneo', 'hyperneo-sessions'],
    ['space', 'hyperneo-spaces'],
  ]) {
    db.prepare(`UPDATE neo_work_driver_targets SET sent_receipt = json_set(sent_receipt,
      '$.ref', (json_set(json_extract(sent_receipt, '$.ref'), '$.adapter', ?) || ''))
      WHERE CASE WHEN json_valid(sent_receipt) THEN
        CASE WHEN json_valid(json_extract(sent_receipt, '$.ref')) THEN
          json_extract(json_extract(sent_receipt, '$.ref'), '$.adapter') END END = ?`).run(
      newId,
      oldId
    );
  }
}
