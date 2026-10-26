import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-todo-done-when-wording.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
const rpc = (name, input = {}) => {
  const reply = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply.value ?? reply;
};
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now();
const sql = (statement) => execFileSync('sqlite3', [`${run}/data/daemon.db`, statement]);

const opened = rpc('neo.open');
assert(opened.ok);
const ask = crypto.randomUUID();
sql(`INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic wording','Synthetic verification only','open',${now},${now});`);

const evidence = {};
const added = rpc('neo.todo.add', {
  askId: ask,
  title: 'Reword the gauge',
  doneWhen: 'gauge level reads 5',
  instruction: 'Reword the done-when.',
  target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'verify' } },
});
assert.equal(added.ok, true, JSON.stringify(added));
const edited = rpc('neo.todo.edit', { todoId: added.todo.id, doneWhen: 'gauge level reads 6' });
assert.equal(edited.ok, true, JSON.stringify(edited));
assert.equal(edited.todo.doneWhen, 'gauge level reads 6');
evidence.reworded = { todoId: added.todo.id, doneWhen: edited.todo.doneWhen };

mkdirSync(`${run}/evidence`, { recursive: true });
writeFileSync(`${run}/evidence/neo-todo-done-when-wording.json`, JSON.stringify(evidence, null, 1));
console.log('PASS todo done-when wording:', run);
