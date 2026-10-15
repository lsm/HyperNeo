import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name);

export function runMigration380(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'follows')) return;
  db.exec('ALTER TABLE neo_work ADD COLUMN follows TEXT');
  if (!hasTable(db, 'neo_work_pr_claims')) return;
  if (hasTable(db, 'neo_work_prs')) {
    const named = db
      .prepare(
        "SELECT work_id AS workId, url_key AS urlKey FROM neo_work_pr_claims WHERE claim = 'named'"
      )
      .all() as { workId: string; urlKey: string }[];
    const read = db.prepare('SELECT prs_json AS prs FROM neo_work_prs WHERE work_id = ?');
    const write = db.prepare('UPDATE neo_work_prs SET prs_json = ? WHERE work_id = ?');
    for (const workId of new Set(named.map((row) => row.workId))) {
      const row = read.get(workId) as { prs: string } | null;
      if (!row) continue;
      const dropped = new Set(
        named.filter((claim) => claim.workId === workId).map((claim) => claim.urlKey)
      );
      const prs = (JSON.parse(row.prs) as { url: string }[]).filter(
        (pr) => !dropped.has(pr.url.toLowerCase())
      );
      write.run(JSON.stringify(prs), workId);
    }
  }
  db.exec("DELETE FROM neo_work_pr_claims WHERE claim = 'named'");
}
