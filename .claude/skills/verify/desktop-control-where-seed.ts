import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const [run] = process.argv.slice(2);
if (!run) throw new Error('usage: dc-where-seed.ts <run>');
const db = new Database(join(run, 'data/daemon.db'));
const now = Date.now();
const ask = (id: string, title: string, at: number) =>
  db.run(
    `INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
     VALUES (?, 'neo:proof', ?, 'Synthetic request', 'open', ?, ?)`,
    [id, title, at, at]
  );
const todo = (
  id: string,
  askId: string,
  position: number,
  title: string,
  state: string,
  worker: { adapter: string; id: string } | null,
  blocked: string | null = null
) => {
  db.run(
    `INSERT INTO neo_todos (id, ask_id, position, title, done_when, instruction, state, approved_at, created_at, updated_at, started_at, blocked_reason, blocked_by)
     VALUES (?, ?, ?, ?, 'Done on the site', 'Use the site', ?, ?, ?, ?, ?, ?, ?)`,
    [id, askId, position, title, state, now, now, now, state === 'todo' ? null : now, blocked, blocked ? 'needs-human' : null]
  );
  if (worker)
    db.run(`INSERT INTO neo_todo_sessions (todo_id, target, ref, started_at) VALUES (?, ?, ?, ?)`, [
      id,
      JSON.stringify({ adapter: worker.adapter }),
      JSON.stringify(worker),
      now,
    ]);
};
ask('errands', 'Errands on the clinic and tax sites', now);
todo('dentist', 'errands', 0, 'Book the dentist on the clinic site', 'doing', { adapter: 'claude-desktop', id: 'cd-dentist' });
todo('taxes', 'errands', 1, 'File the tax form', 'blocked', { adapter: 'hyperneo', id: 'worker-taxes' }, 'Waiting for the human to sign in');
todo('passport', 'errands', 2, 'Renew the passport online', 'todo', null);
ask('trip', 'Plan the winter trip', now - 60_000);
todo('flights', 'trip', 0, 'Compare flights', 'doing', { adapter: 'codex-desktop', id: 'cx-flights' });
db.run(
  `INSERT INTO neo_questions (id, ask_id, text, kind, state, created_at) VALUES ('q-dates', 'trip', 'Are the trip dates fixed?', 'yesno', 'open', ?)`,
  [now - 30_000]
);
for (let index = 0; index < 5; index++) {
  ask(`filler-${index}`, `Background chore ${index + 1}`, now - 120_000 - index * 1000);
  todo(`filler-todo-${index}`, `filler-${index}`, 0, `Tidy folder ${index + 1}`, 'doing', { adapter: 'hyperneo', id: `worker-${index}` });
}
db.close();
console.log(JSON.stringify({ seeded: ['errands', 'trip', 'filler x5'] }));
