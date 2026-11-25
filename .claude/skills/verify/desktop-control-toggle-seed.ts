import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const [run, session = 'neo:proof'] = process.argv.slice(2);
if (!run) throw new Error('usage: desktop-control-toggle-seed.ts <run>');
const db = new Database(join(run, 'data/daemon.db'));
const now = Date.now();
db.run(
  `INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
   VALUES ('desktop-ask', ?, 'Errands on the clinic and tax sites', 'Book and file', 'open', ?, ?)`,
  [session, now, now]
);
for (const [position, id, title, worker] of [
  [0, 'dentist', 'Book the dentist on the clinic site', 'worker-dentist'],
  [1, 'taxes', 'File the tax form', 'worker-taxes'],
] as const) {
  db.run(
    `INSERT INTO neo_todos (id, ask_id, position, title, done_when, instruction, state, approved_at, created_at, updated_at, started_at)
     VALUES (?, 'desktop-ask', ?, ?, 'Done on the site', 'Use the site', 'doing', ?, ?, ?, ?)`,
    [id, position, title, now, now, now, now]
  );
  db.run(`INSERT INTO neo_todo_sessions (todo_id, target, ref, started_at) VALUES (?, ?, ?, ?)`, [
    id,
    JSON.stringify({ adapter: 'hyperneo' }),
    JSON.stringify({ adapter: 'hyperneo', id: worker }),
    now,
  ]);
}
db.run(
  `INSERT INTO neo_todos (id, ask_id, position, title, done_when, instruction, state, approved_at, created_at, updated_at, started_at, blocked_reason, blocked_by)
   VALUES ('visa', 'desktop-ask', 2, 'Pay the visa fee', 'Paid on the site', 'Use the site', 'blocked', ?, ?, ?, ?, 'Waiting for the human to sign in', 'needs-human')`,
  [now, now, now, now]
);
db.run(
  `INSERT INTO neo_todos (id, ask_id, position, title, done_when, instruction, state, approved_at, created_at, updated_at)
   VALUES ('passport', 'desktop-ask', 3, 'Renew the passport online', 'Renewed on the site', 'Use the site', 'todo', ?, ?, ?)`,
  [now, now, now]
);
db.close();
console.log(JSON.stringify({ todos: ['dentist', 'taxes', 'visa', 'passport'] }));
