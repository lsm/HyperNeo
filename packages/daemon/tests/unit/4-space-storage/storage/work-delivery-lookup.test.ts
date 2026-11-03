import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { WorkDeliveryInputRepository } from '../../../../src/storage/repositories/work-delivery-input-repository.ts';
import { seedWorkDeliveryFixture } from '../../helpers/work-delivery-fixture.ts';

test('worker delivery history uses a bounded lookup without changing identity or receipt order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-lookup-'));
  const db = new Database(join(directory, 'fixture.db'));
  try {
    runMigrations(db, () => {});
    createTables(db);
    db.exec(`DROP INDEX IF EXISTS idx_work_delivery_inputs_ref;
      DELETE FROM migration_markers WHERE key='migration_469'`);
    seedWorkDeliveryFixture(db);
    const retained = () =>
      createHash('sha256')
        .update(
          JSON.stringify(db.prepare('SELECT * FROM work_delivery_inputs ORDER BY rowid').all())
        )
        .digest('hex');
    const original = retained();
    runMigrations(db, () => {});
    runMigrations(db, () => {});
    expect(retained()).toBe(original);
    const statements: string[] = [];
    const observed = new Proxy(db, {
      get(target, key) {
        return key === 'prepare'
          ? (sql: string) => {
              statements.push(sql);
              return target.prepare(sql);
            }
          : Reflect.get(target, key);
      },
    });
    const inputs = new WorkDeliveryInputRepository(observed);
    const durations: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const history = inputs.list({ adapter: 'codex-desktop', id: 'fixture-worker-0' });
      durations.push(performance.now() - started);
      expect(history.map((row) => row.id)).toEqual(
        Array.from({ length: 17 }, (_, n) => `fixture-${n * 88}`)
      );
    }
    const sql = statements[0]!;
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('codex-desktop', 'fixture-worker-0', null) as { detail: string }[];
    process.stdout.write(`${JSON.stringify({ rows: 1466, durationsMs: durations, plan })}\n`);
    expect(plan.some((row) => row.detail.startsWith('SEARCH work_delivery_inputs'))).toBe(true);
    expect(plan.some((row) => /SCAN work_delivery_inputs|TEMP B-TREE/.test(row.detail))).toBe(
      false
    );
    const insert = db.prepare(`INSERT INTO work_delivery_inputs
      (id,todo_id,origin_session_id,target,message,accepted_at,deadline_at,outcome)
      VALUES (?,'edges','fixture-neo','{}',?,2000,32000,?)`);
    const add = (id: string, outcome: unknown) => insert.run(id, id, JSON.stringify(outcome));
    add('z-local-first', {
      ref: { adapter: 'copilot-cli', id: 'same' },
      receipt: { inputId: 'one' },
    });
    add('a-local-second', { ref: { adapter: 'copilot-cli', id: 'same', daemon: null } });
    add('remote', { ref: { adapter: 'copilot-cli', id: 'same', daemon: 'peer' } });
    add('empty-daemon', { ref: { adapter: 'copilot-cli', id: 'same', daemon: '' } });
    add('other-adapter', { ref: { adapter: 'codex-desktop', id: 'same' } });
    add('failed', { failure: 'not delivered' });
    add('pending', null);
    expect(inputs.list({ adapter: 'copilot-cli', id: 'same' }).map((row) => row.id)).toEqual([
      'z-local-first',
      'a-local-second',
    ]);
    expect(
      inputs.list({ adapter: 'copilot-cli', id: 'same', daemon: 'peer' }).map((row) => row.id)
    ).toEqual(['remote']);
    expect(
      inputs.list({ adapter: 'copilot-cli', id: 'same', daemon: '' }).map((row) => row.id)
    ).toEqual(['empty-daemon']);
    expect(inputs.list('edges')).toHaveLength(7);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
