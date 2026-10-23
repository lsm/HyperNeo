import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runMigration426 } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { getNeoPackPreference } from '../../../../src/lib/neo/preferences.ts';

const dbs: Database[] = [];
function fixture() {
  const db = new Database(':memory:');
  dbs.push(db);
  runMigration426(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function save(
  db: Database,
  pack: string,
  kind: string,
  scope: string,
  key: string,
  value: unknown
) {
  db.prepare(
    `INSERT OR REPLACE INTO neo_pack_preferences VALUES (?, ?, ?, ?, ?, 'human', 123)`
  ).run(pack, kind, scope, key, JSON.stringify(value));
}

describe('pack preference lookup', () => {
  test('creates an empty settings store without applying install-specific defaults', () => {
    const db = fixture();
    expect(db.prepare('SELECT COUNT(*) AS n FROM neo_pack_preferences').get()).toEqual({ n: 0 });
    expect(
      getNeoPackPreference(db, 'coding', { kind: 'repo', key: 'synthetic/new' }, 'mergePolicy')
    ).toBeNull();
  });
  test('missing is unanswered; exact scope wins over same-pack global, including false and zero', () => {
    const db = fixture();
    const scope = { kind: 'repo' as const, key: 'synthetic/new' };
    expect(getNeoPackPreference(db, 'coding', scope, 'mergePolicy')).toBeNull();
    save(db, 'coding', 'global', '', 'mergePolicy', 'human');
    expect(getNeoPackPreference(db, 'coding', scope, 'mergePolicy')).toMatchObject({
      value: 'human',
      setBy: 'human',
      setAt: 123,
      scope: { kind: 'global', key: '' },
    });
    save(db, 'coding', 'repo', scope.key, 'mergePolicy', false);
    expect(getNeoPackPreference(db, 'coding', scope, 'mergePolicy')?.value).toBe(false);
    save(db, 'coding', 'project', scope.key, 'mergePolicy', 0);
    expect(
      getNeoPackPreference(db, 'coding', { kind: 'project', key: scope.key }, 'mergePolicy')?.value
    ).toBe(0);
    expect(getNeoPackPreference(db, 'another', scope, 'mergePolicy')).toBeNull();
    expect(
      getNeoPackPreference(db, 'coding', { kind: 'global', key: '' }, 'mergePolicy')?.value
    ).toBe('human');
  });
  test('reapplying schema preserves human settings and unrelated stored bytes', () => {
    const db = fixture();
    save(db, 'coding', 'repo', 'synthetic/repo', 'mergePolicy', 'human');
    save(db, 'custom', 'project', 'synthetic', 'data', 'stored bytes '.repeat(1000));
    const before = db
      .prepare('SELECT * FROM neo_pack_preferences ORDER BY pack, scope_key, key')
      .all();
    runMigration426(db);
    expect(
      db.prepare('SELECT * FROM neo_pack_preferences ORDER BY pack, scope_key, key').all()
    ).toEqual(before);
  });
});
