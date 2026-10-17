#!/usr/bin/env bun

import { Database } from '../src/storage/sqlite-compat';
import { revertMigration387 } from '../src/storage/schema/m387-neo-ask-todo-tables';

const dbPath = process.argv[2];

if (!dbPath) {
  console.error('Usage: bun neo-restore-legacy-asks.ts <db-path>');
  process.exit(1);
}

const db = new Database(dbPath);
db.exec('PRAGMA foreign_keys = ON');
const outcome = db.transaction(() => revertMigration387(db))();
db.close();
console.log(
  {
    restored: `Restored the pre-387 Neo ask tables in ${dbPath}`,
    nothing: `No legacy_neo_asks in ${dbPath}; nothing to restore`,
    has_rows: `The new Neo ask tables in ${dbPath} hold rows; nothing was changed`,
  }[outcome]
);
if (outcome === 'has_rows') process.exit(1);
