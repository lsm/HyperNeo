import type { Database } from '../sqlite-compat.ts';

export function createNeoPackPreferencesTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_pack_preferences (
    pack TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'repo', 'project')),
    scope_key TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (pack, scope_kind, scope_key, key),
    CHECK (scope_kind <> 'global' OR scope_key = '')
  )`);
}

export function runMigration426(db: Database): void {
  createNeoPackPreferencesTable(db);
  const insert = db.prepare(`INSERT INTO neo_pack_preferences
    (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('coding', 'repo', ?, ?, ?, 'seed', ?)
    ON CONFLICT (pack, scope_kind, scope_key, key) DO NOTHING`);
  const now = Date.now();
  db.transaction(() => {
    for (const [repo, preferences] of Object.entries({
      'lsm/HyperNeo': {
        mergePolicy: 'review_bot',
        reviewBot: 'hyperneo-ai-test',
        humanSignoff: ['docs/design/**', 'docs/architecture/**'],
      },
      'lsm/qlark': {
        mergePolicy: 'review_bot',
        reviewBot: 'hyperneo-ai-test',
        humanSignoff: ['docs/design/**', 'docs/plan/**'],
      },
      'lsm/research': { mergePolicy: 'ci_only', humanSignoff: [] },
      'lsm/ops': { mergePolicy: 'ci_only', humanSignoff: [] },
    })) {
      for (const [key, value] of Object.entries(preferences))
        insert.run(repo, key, JSON.stringify(value), now);
    }
  })();
}
