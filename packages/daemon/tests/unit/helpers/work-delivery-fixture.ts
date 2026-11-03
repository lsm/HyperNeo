import type { Database } from '../../../src/storage/sqlite-compat.ts';

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
