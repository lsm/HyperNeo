import { describe, expect, test } from 'bun:test';
import { deriveSdkMessageColumns } from '../../../../src/storage/sdk-message-columns';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  backfillSdkMessageColumns,
  runMigration413,
} from '../../../../src/storage/schema/m413-sdk-message-columns';
import { runMigration414 } from '../../../../src/storage/schema/m414-sdk-message-filter-eligibility';

describe('SDK message filter eligibility contracts', () => {
  test('a completed slice-2 database receives typed eligibility before filters run', async () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE sdk_messages (seq INTEGER PRIMARY KEY, sdk_message TEXT, task_id TEXT, replacement_metadata_normalized INTEGER DEFAULT 1); CREATE TABLE migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER)'
      );
      runMigration413(db);
      db.exec(
        'ALTER TABLE sdk_messages DROP COLUMN user_status_eligible; ALTER TABLE sdk_messages DROP COLUMN task_input_eligible'
      );
      db.prepare('INSERT INTO migration_markers VALUES (?, 1)').run(
        'sdk_message_columns_backfilled'
      );
      const insert = db.prepare('INSERT INTO sdk_messages (sdk_message) VALUES (?)');
      insert.run(
        JSON.stringify({ type: 'user', isReplay: null, inputKind: null, isSynthetic: true })
      );
      insert.run(JSON.stringify({ type: 'user', isReplay: false, isSynthetic: true }));
      runMigration414(db);
      runMigration414(db);
      await backfillSdkMessageColumns(db, () => {});
      expect(
        db
          .prepare('SELECT user_status_eligible,task_input_eligible FROM sdk_messages ORDER BY seq')
          .all()
      ).toEqual([
        { user_status_eligible: 0, task_input_eligible: 0 },
        { user_status_eligible: 1, task_input_eligible: 1 },
      ]);
      expect(
        db
          .prepare('SELECT 1 FROM migration_markers WHERE key = ?')
          .get('sdk_message_columns_backfilled_v2')
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });
  test('integer-affinity flags preserve JSON scalar comparisons', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE flags (value INTEGER)');
      for (const value of [null, false, true, 0, 1, '0', '1', '1e2']) {
        const body = { type: 'result', is_error: value };
        db.exec('DELETE FROM flags');
        db.prepare('INSERT INTO flags VALUES (?)').run(deriveSdkMessageColumns(body).is_error);
        const expected = db
          .prepare(
            "SELECT COALESCE(json_extract(?, '$.is_error'), 0) = 0 AS zero, COALESCE(json_extract(?, '$.is_error'), 0) = 1 AS one"
          )
          .get(JSON.stringify(body), JSON.stringify(body));
        expect(
          db
            .prepare(
              'SELECT COALESCE(value, 0) = 0 AS zero, COALESCE(value, 0) = 1 AS one FROM flags'
            )
            .get()
        ).toEqual(expected);
      }
    } finally {
      db.close();
    }
  });
  test.each([
    ['missing', {}, 1],
    ['omitted undefined', { isReplay: undefined }, 1],
    ['false', { isReplay: false }, 1],
    ['null', { isReplay: null }, 0],
    ['zero', { isReplay: 0 }, 0],
    ['true', { isReplay: true }, 0],
    ['one', { isReplay: 1 }, 0],
    ['text false', { isReplay: 'false' }, 0],
    ['text zero', { isReplay: '0' }, 0],
    ['mismatched type', { type: 'assistant' }, 0],
  ] as const)('status projection preserves the %s replay case', (_name, body, eligible) => {
    expect(deriveSdkMessageColumns({ type: 'user', ...body })).toMatchObject({
      user_status_eligible: eligible,
    });
  });

  test.each([
    ['task', { inputKind: 'task' }, 1],
    ['task with false synthetic flag', { inputKind: 'task', isSynthetic: false }, 1],
    ['missing', { isSynthetic: true }, 1],
    ['omitted undefined', { inputKind: undefined, isSynthetic: true }, 1],
    ['null', { inputKind: null, isSynthetic: true }, 0],
    ['false', { inputKind: false, isSynthetic: true }, 0],
    ['zero', { inputKind: 0, isSynthetic: true }, 0],
    ['system', { inputKind: 'system', isSynthetic: true }, 0],
    ['human', { inputKind: 'human', isSynthetic: true }, 0],
    ['missing with false synthetic flag', { isSynthetic: false }, 0],
    ['missing with zero synthetic flag', { isSynthetic: 0 }, 0],
    ['missing with null synthetic flag', { isSynthetic: null }, 0],
    ['missing with integer synthetic flag', { isSynthetic: 1 }, 1],
    ['missing with fractional synthetic flag', { isSynthetic: 1.75 }, 1],
    ['missing with numeric text synthetic flag', { isSynthetic: '1tail' }, 1],
    ['missing with exponent text synthetic flag', { isSynthetic: '1e2' }, 1],
    ['missing with non-SQL whitespace', { isSynthetic: '\u00a01' }, 0],
    ['mismatched type', { type: 'assistant', inputKind: 'task' }, 0],
  ] as const)('task projection preserves the %s input case', (_name, body, eligible) => {
    expect(deriveSdkMessageColumns({ type: 'user', ...body })).toMatchObject({
      task_input_eligible: eligible,
    });
  });
});
