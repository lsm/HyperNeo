import { describe, expect, test } from 'bun:test';
import { runMigration511 } from '../../../../../src/storage/schema/m511-provider-needs-login.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration511', () => {
  test('adds the nullable needs_login_at column once and leaves existing rows alone', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, provider_id TEXT UNIQUE NOT NULL);
      INSERT INTO providers VALUES ('row-1', 'anthropic');
    `);
    runMigration511(db);
    runMigration511(db);
    expect(db.prepare('SELECT id, needs_login_at FROM providers').all()).toEqual([
      { id: 'row-1', needs_login_at: null },
    ]);
    db.close();
  });

  test('leaves a database without the providers table untouched', () => {
    const db = new Database(':memory:');
    runMigration511(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'providers'").all()).toEqual([]);
    db.close();
  });
});
