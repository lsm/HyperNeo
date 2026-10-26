import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-local-ownership-doors.mjs <port> <run-dir>');
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

const evidence = {};

const opened = rpc('neo.open');
assert.equal(opened.ok, true, JSON.stringify(opened));
const inspected = rpc('daemon.session.inspect', { sessionId: opened.sessionId });
assert.equal(inspected.accepted, true, JSON.stringify(inspected));
assert.equal(inspected.resource.id, opened.sessionId);
evidence.inspect = { sessionId: opened.sessionId, status: inspected.resource.status };

const moved = rpc('neo.project.move', { id: 'inbox', parentId: null, expectedRevision: 1 });
evidence.moveBoundary = moved;
assert.equal(moved.ok, false, 'the Inbox cannot be nested and refuses by name, not by role');

const goal = rpc('goal.session.create', {
  ownerSessionId: opened.sessionId,
  title: 'Synthetic verification goal',
  doneTest: 'Journey only',
});
assert.equal(goal.accepted, true, JSON.stringify(goal));
const listed = rpc('goal.session.list', { ownerSessionId: opened.sessionId });
assert.equal(listed.accepted, true);
assert(listed.goals.some((item) => item.id === goal.goal.id));
evidence.goal = { id: goal.goal.id, owner: goal.goal.ownerSessionId };

mkdirSync(`${run}/evidence`, { recursive: true });
writeFileSync(`${run}/evidence/neo-local-ownership-doors.json`, JSON.stringify(evidence, null, 1));
console.log('PASS local ownership doors:', run);
