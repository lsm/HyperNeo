import { describe, expect, test } from 'bun:test';
import { NeoAskCheckRepository } from '../../../../src/storage/repositories/neo-ask-check-repository';
import { runMigration325 } from '../../../../src/storage/schema/m325-neo-ask-checks';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration325', () => {
  test('creates the ask check table once, and skips databases without asks', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO neo_asks VALUES ('a1')");
    runMigration325(db);
    runMigration325(db);
    const checks = new NeoAskCheckRepository(db);
    checks.markTold('a1', 'sig-1', 10);
    checks.markTold('a1', 'sig-2', 20);
    expect(checks.get('a1')).toEqual({ askId: 'a1', signature: 'sig-2', toldAt: 20 });
    const bare = new Database(':memory:');
    runMigration325(bare);
    expect(new NeoAskCheckRepository(bare).get('a1')).toBe(null);
  });
});
