import type { Database } from '../sqlite-compat.ts';

export function runMigration358(db: Database): void {
  const additions = {
    neo_asks: {
      revision: 'INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)',
      approved_revision: 'INTEGER CHECK (approved_revision >= 0)',
    },
    neo_ask_items: { verified_definition_hash: 'TEXT' },
  };
  db.transaction(() => {
    for (const [table, fields] of Object.entries(additions)) {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (column) => column.name
        )
      );
      if (!columns.size) continue;
      for (const [name, definition] of Object.entries(fields)) {
        if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  })();
}
