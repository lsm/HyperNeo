import { describe, expect, test } from 'bun:test';
import { runMigration306 } from '../../../../src/storage/schema/m306-sandbox-default-off';
import { Database } from '../../../../src/storage/sqlite-compat';

function settingsDb(settings?: unknown) {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE global_settings (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, updated_at TEXT)'
  );
  if (settings !== undefined)
    db.prepare('INSERT INTO global_settings (id, settings) VALUES (1, ?)').run(
      typeof settings === 'string' ? settings : JSON.stringify(settings)
    );
  return db;
}

function stored(db: Database) {
  const row = db.prepare('SELECT settings FROM global_settings WHERE id = 1').get() as
    | { settings: string }
    | undefined;
  return row?.settings;
}

describe('runMigration306', () => {
  test('turns a stored sandbox off and keeps the rest of the settings', () => {
    const db = settingsDb({
      model: 'sonnet',
      sandbox: { enabled: true, excludedCommands: ['git'] },
    });
    runMigration306(db);
    expect(JSON.parse(stored(db)!)).toEqual({
      model: 'sonnet',
      sandbox: { enabled: false, excludedCommands: ['git'] },
    });
  });

  test('leaves settings without an enabled sandbox untouched', () => {
    const off = settingsDb({ sandbox: { enabled: false } });
    const none = settingsDb({ model: 'sonnet' });
    runMigration306(off);
    runMigration306(none);
    expect(JSON.parse(stored(off)!)).toEqual({ sandbox: { enabled: false } });
    expect(JSON.parse(stored(none)!)).toEqual({ model: 'sonnet' });
  });

  test('tolerates a missing row, a missing table and unreadable settings', () => {
    const empty = settingsDb();
    runMigration306(empty);
    expect(stored(empty)).toBeUndefined();
    expect(() => runMigration306(new Database(':memory:'))).not.toThrow();
    const broken = settingsDb('{not json');
    runMigration306(broken);
    expect(stored(broken)).toBe('{not json');
  });
});
