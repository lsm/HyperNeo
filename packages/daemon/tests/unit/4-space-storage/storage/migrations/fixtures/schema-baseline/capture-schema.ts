import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('Usage: capture-schema.ts <source-checkout> <output.sql>');

const sqliteUrl = pathToFileURL(resolve(root, 'packages/daemon/src/storage/sqlite-compat.ts'));
const schemaUrl = pathToFileURL(resolve(root, 'packages/daemon/src/storage/schema/index.ts'));
const { Database } = (await import(
  sqliteUrl.href
)) as typeof import('../../../../../../../src/storage/sqlite-compat.ts');
const { runMigrations, createTables, configureMessageSearchFts } = (await import(
  schemaUrl.href
)) as typeof import('../../../../../../../src/storage/schema/index.ts');
const db = new Database(':memory:');
try {
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  createTables(db);
  configureMessageSearchFts(db);
  const shadows = new Set(
    (db.prepare('PRAGMA table_list').all() as { name: string; type: string }[])
      .filter((row) => row.type === 'shadow')
      .map((row) => row.name)
  );
  const objects = (
    db
      .prepare(
        `SELECT tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'trigger', type = 'index', rowid`
      )
      .all() as { tbl_name: string; sql: string }[]
  ).filter((row) => !shadows.has(row.tbl_name));
  const markers = db.prepare('SELECT key FROM migration_markers ORDER BY key').all() as {
    key: string;
  }[];
  const dump =
    objects.map((row) => `${row.sql};`).join('\n\n') +
    '\n\n' +
    markers
      .map(
        (row) =>
          `INSERT INTO migration_markers (key, applied_at) VALUES ('${row.key.replaceAll("'", "''")}', 1);`
      )
      .join('\n') +
    '\n';
  writeFileSync(output, dump);
} finally {
  db.close();
}
