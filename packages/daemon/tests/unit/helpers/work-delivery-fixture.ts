import type { Database } from '../../../src/storage/sqlite-compat.ts';
import { WorkDeliveryInputRepository } from '../../../src/storage/repositories/work-delivery-input-repository.ts';

export function measureWorkDeliveryLookup(db: Database) {
  let query = '';
  const inputs = new WorkDeliveryInputRepository(
    new Proxy(db, {
      get(target, key) {
        return key === 'prepare'
          ? (sql: string) => {
              query = sql;
              return target.prepare(sql);
            }
          : Reflect.get(target, key);
      },
    })
  );
  const durationsMs: number[] = [];
  const ref = { adapter: 'codex-desktop', id: 'fixture-worker-0' };
  let ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    ids = inputs.list(ref).map((row) => row.id);
    durationsMs.push(performance.now() - start);
  }
  return {
    durationsMs,
    ids,
    plan: db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(ref.adapter, ref.id, null) as {
      detail: string;
    }[],
  };
}

export function seedWorkDeliveryFixture(db: Database, count = 1466): void {
  const insert = db.prepare(`INSERT INTO work_delivery_inputs
    (id, todo_id, origin_session_id, target, message, accepted_at, deadline_at, outcome)
    VALUES (?, 'fixture-todo', 'fixture-neo', ?, ?, ?, ?, ?)`);
  const message = 'Synthetic retained instruction '.repeat(120);
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const ref = { adapter: 'codex-desktop', id: `fixture-worker-${i % 88}` };
      insert.run(
        `fixture-${i}`,
        JSON.stringify({ verb: 'send', ref }),
        message,
        i,
        i + 30000,
        JSON.stringify({ ref, delivery: { delivered: true, detail: 'x'.repeat(120) } })
      );
    }
  })();
}
