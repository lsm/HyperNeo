import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runMigration303 } from '../../../../src/storage/schema/m303-external-delivery-task-index';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration303', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  test('indexes external event deliveries by task so task feeds stop scanning them', () => {
    db.exec(
      'CREATE TABLE space_external_event_deliveries (event_id TEXT, delivery_key TEXT, task_id TEXT, state TEXT)'
    );
    runMigration303(db);
    runMigration303(db);
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM space_external_event_deliveries WHERE task_id = ?')
      .all('task-1') as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'USING INDEX idx_space_external_event_deliveries_task'
    );
  });

  test('skips databases without the table', () => {
    runMigration303(db);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'").get()
    ).toEqual({ n: 0 });
  });
});
