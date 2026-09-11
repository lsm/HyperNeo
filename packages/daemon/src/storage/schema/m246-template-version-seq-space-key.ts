import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration246(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_template_version_seq')) return;
  if (tableHasColumn(db, 'space_agent_template_version_seq', 'space_id')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    rebuildVersionSeq(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function rebuildVersionSeq(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_agent_template_version_seq_m246_new (
      space_id TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      next_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (space_id, key)
    )
  `);
  db.exec(
    `INSERT INTO space_agent_template_version_seq_m246_new (space_id, key, next_version)
     SELECT '', key, next_version FROM space_agent_template_version_seq`
  );
  if (tableHasColumn(db, 'space_agent_templates', 'space_id')) {
    db.exec(
      `INSERT INTO space_agent_template_version_seq_m246_new (space_id, key, next_version)
         SELECT t.space_id, t.key, MAX(t.version, COALESCE(s.next_version, 1))
           FROM space_agent_templates t
           LEFT JOIN space_agent_template_version_seq s ON s.key = t.key
       ON CONFLICT(space_id, key) DO UPDATE SET
         next_version = MAX(next_version, excluded.next_version)`
    );
  }
  db.exec(`DROP TABLE space_agent_template_version_seq`);
  db.exec(
    `ALTER TABLE space_agent_template_version_seq_m246_new RENAME TO space_agent_template_version_seq`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_template_version_seq_key
       ON space_agent_template_version_seq(key, next_version)`
  );
  if (tableHasColumn(db, 'space_agent_templates', 'space_id')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_agent_templates_key ON space_agent_templates(key)`
    );
    renumberSharedKeys(db);
  }
}

function renumberSharedKeys(db: BunDatabase): void {
  const shared = db
    .prepare(
      `SELECT key FROM space_agent_templates GROUP BY key HAVING COUNT(*) > 1 ORDER BY key ASC`
    )
    .all() as Array<{ key: string }>;
  if (shared.length === 0) return;

  const owners = db.prepare(
    `SELECT space_id, version FROM space_agent_templates WHERE key = ? ORDER BY space_id ASC`
  );
  const ceiling = db.prepare(
    `SELECT COALESCE(MAX(next_version), 0) AS top FROM space_agent_template_version_seq WHERE key = ?`
  );
  const setVersion = db.prepare(
    `UPDATE space_agent_templates SET version = ? WHERE space_id = ? AND key = ?`
  );
  const setCounter = db.prepare(
    `INSERT INTO space_agent_template_version_seq (space_id, key, next_version) VALUES (?, ?, ?)
     ON CONFLICT(space_id, key) DO UPDATE SET next_version = MAX(next_version, excluded.next_version)`
  );

  for (const { key } of shared) {
    const rows = owners.all(key) as Array<{ space_id: string; version: number }>;
    const top = (ceiling.get(key) as { top: number }).top;
    let next = Math.max(top, ...rows.map((row) => row.version));
    for (const row of rows.slice(1)) {
      next += 1;
      setVersion.run(next, row.space_id, key);
      setCounter.run(row.space_id, key, next);
    }
    setCounter.run(rows[0].space_id, key, Math.max(rows[0].version, top));
  }
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}
