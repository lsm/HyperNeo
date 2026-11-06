import { describe, expect, test } from 'bun:test';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { codingHumanHandoffs } from '../../../../src/lib/neo/packs/coding/human-merge-notice.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('codingHumanHandoffs', () => {
  test('reads on the read lane before the Neo conversation is reserved', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    createCodingPackTables(db);
    const neo = new NeoRepository(db);
    neo.reserveBinding({ sessionId: 'neo:fresh', projectId: null, kind: 'neo' });
    db.exec('PRAGMA query_only=ON');
    expect(codingHumanHandoffs(db, [])).toEqual([]);
    db.exec('PRAGMA query_only=OFF');
    expect(neo.readConversationId()).toBeNull();
    db.close();
  });
});
