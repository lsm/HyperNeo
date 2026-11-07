import { describe, expect, test } from 'bun:test';
import { runMigration488 } from '../../../../../src/storage/schema/m488-pair-voided-at.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('migration 488 pairing code voided_at', () => {
  test('adds a nullable voided_at column once and skips a database without pairing codes', () => {
    const db = new Database(':memory:');
    runMigration488(db);
    db.exec(
      "CREATE TABLE pairing_codes (id TEXT PRIMARY KEY); INSERT INTO pairing_codes VALUES ('c')"
    );
    runMigration488(db);
    runMigration488(db);
    expect(db.prepare('SELECT id, voided_at FROM pairing_codes').all()).toEqual([
      { id: 'c', voided_at: null },
    ]);
    db.close();
  });
});
