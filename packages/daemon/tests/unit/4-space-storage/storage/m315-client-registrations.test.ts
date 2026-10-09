import { describe, expect, test } from 'bun:test';
import { runMigration315 } from '../../../../src/storage/schema/m315-client-registrations';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration315', () => {
  test('creates the client registration table once, keyed by client and kind', () => {
    const db = new Database(':memory:');
    runMigration315(db);
    runMigration315(db);
    db.prepare("INSERT INTO client_registrations VALUES ('c', 'a', '{}', 0)").run();
    db.prepare("INSERT INTO client_registrations VALUES ('c', 'b', '{}', 0)").run();
    expect(() =>
      db.prepare("INSERT INTO client_registrations VALUES ('c', 'a', '{}', 1)").run()
    ).toThrow();
  });
});
