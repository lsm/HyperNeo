import type { Database } from '../sqlite-compat.ts';

export function runMigration481(db: Database): void {
  db.transaction(() => {
    for (const table of ['paired_devices', 'pairing_codes']) {
      const row = db
        .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
        .get('table', table) as { sql: string } | null;
      if (!row || row.sql.includes("'agent'")) continue;
      const temporary = `${table}_agent`;
      db.exec(row.sql.replace(table, temporary).replace("'daemon'", "'daemon', 'agent'"));
      db.exec(`INSERT INTO ${temporary} SELECT * FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
    }
  })();
}
