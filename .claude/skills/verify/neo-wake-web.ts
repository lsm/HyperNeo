import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { seedNeoWake } from '../../../packages/daemon/tests/helpers/neo-wake-corpus.ts';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', 'neo.open', '{}'], {
  env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
});
const response = JSON.parse(await new Response(child.stdout).text());
assert.equal(await child.exited, 0);
const root = response.reply.sessionId;
const db = new Database(`${run}/data/daemon.db`);
try {
  const complete = seedNeoWake(db, root.slice(4));
  complete.finish('Guide check complete.');
  const store = new NeoAskTodoRepository(db);
  const todo = store.getTodo(complete.expected.find(item => item.kind === 'todo')!.id)!;
  store.updateTodo(todo, {state:'removed',reason:'Replaced during synthetic verification.'}, Date.now());
  const empty = seedNeoWake(db, root.slice(4), false);
  empty.finish('No changes needed.');
  const active = seedNeoWake(db, root.slice(4), false);
  writeFileSync(`${run}/evidence/neo-wake-web-seed.json`, JSON.stringify({
    root, complete: complete.scheduleId, empty: empty.scheduleId, active: active.scheduleId,
    additions: complete.expected,
  }, null, 2));
} finally { db.close(); }
