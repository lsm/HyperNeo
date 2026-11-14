import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProcessIdentity } from '../../../packages/daemon/src/lib/runtime-process-identity.ts';

const [run, worker, pidText] = process.argv.slice(2);
if (!run || !/^[A-Za-z0-9_-]{1,64}$/.test(worker ?? '') || !pidText)
  throw new Error('usage: desktop-takeover-seed.ts <run> <worker-session-id> <driver-pid>');
const pid = Number(pidText);
const startedAt = await readProcessIdentity(pid);
if (!startedAt) throw new Error(`no process identity for ${pid}`);
const db = new Database(join(run, 'data/daemon.db'));
const now = Date.now();
db.run(
  `INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
   VALUES ('desktop-ask', 'neo:proof', 'Desktop proof', 'Book the dentist', 'open', ?, ?)`,
  [now, now]
);
db.run(
  `INSERT INTO neo_todos (id, ask_id, position, title, done_when, named, state, approved_at, created_at, updated_at, started_at)
   VALUES ('desktop-todo', 'desktop-ask', 0, 'Book the dentist on the clinic site', 'Booked', ?, 'doing', ?, ?, ?, ?)`,
  [JSON.stringify({ desktopControl: true }), now, now, now, now]
);
db.run(
  `INSERT INTO neo_todo_sessions (todo_id, target, ref, started_at) VALUES ('desktop-todo', ?, ?, ?)`,
  [JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: worker }), now]
);
db.close();
const directory = join(run, 'data/desktop/workers', worker);
for (const path of [join(run, 'data/desktop'), join(run, 'data/desktop/workers'), directory]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
writeFileSync(join(directory, 'driver.json'), JSON.stringify({ pid, startedAt }), { mode: 0o600 });
console.log(JSON.stringify({ worker, pid, startedAt }));
