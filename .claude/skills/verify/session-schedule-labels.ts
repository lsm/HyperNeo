import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { SessionScheduleListResult } from '../../../packages/shared/src/types/session-schedule.ts';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
async function rpc<T = Record<string, unknown>>(name: string, input: unknown): Promise<T> {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const response = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!response.reply.error, JSON.stringify(response));
  return response.reply;
}
const root = (await rpc('neo.open', {})).sessionId;
const target = { adapter: 'hyperneo', id: root };
const cadence = { kind: 'every', everyMs: 3_600_000 };
const created = await rpc<{ accepted: boolean; goal: { id: string } }>('goal.session.create', {
  ownerSessionId: root, title: 'Ship the guide', doneTest: 'Published', cadence, nudgeEvery: 4,
});
assert(created.accepted, JSON.stringify(created));
const goalId = created.goal.id;
const db = new Database(`${run}/data/daemon.db`, { readonly: true });
const baseline = () => db.query('SELECT facts_lines FROM space_goals WHERE id = ?').get(goalId);
const before = baseline();
const list = async () => {
  const result = await rpc<SessionScheduleListResult>('schedule.session.list', { target });
  assert(result.ok, JSON.stringify(result));
  return result.schedules;
};
try {
  const first = await list();
  const row = first.find((schedule) => schedule.sourceId === goalId)!;
  assert.equal(row.sourceLabel, 'Ship the guide');
  assert.deepEqual(row.target, target);
  assert.deepEqual(row.cadence, cadence);
  assert.equal(row.nudgeEvery - row.dueCount, 4);
  assert.equal(row.lastOutcome, null);
  assert.equal(row.lastSkipReason, null);
  assert(row.nextRunAt! > Date.now());
  assert((await rpc('goal.session.update', { ownerSessionId: root, goalId, title: 'Publish the guide' })).accepted);
  const renamed = await list();
  assert.equal(renamed.find((schedule) => schedule.id === row.id)?.sourceLabel, 'Publish the guide');
  const worker = (await rpc('rpc:session.create', { workspacePath: '/tmp', title: 'Other target' })).sessionId;
  const otherTarget = { adapter: 'hyperneo', id: worker };
  assert((await rpc('schedule.session.create', { target: otherTarget, cadence, note: 'Check the release.' })).ok);
  const other = await rpc<SessionScheduleListResult>('schedule.session.list', { target: otherTarget });
  assert(other.ok && other.schedules.length === 1);
  assert.equal(other.schedules[0].sourceLabel, 'Check the release.');
  assert.deepEqual(await list(), renamed);
  assert((await rpc('schedule.session.pause', { scheduleId: row.id })).ok);
  const paused = await list();
  assert.equal(paused.find((schedule) => schedule.id === row.id)?.status, 'paused');
  assert((await rpc('schedule.session.resume', { scheduleId: row.id })).ok);
  const resumed = await list();
  assert.equal(resumed.find((schedule) => schedule.id === row.id)?.status, 'active');
  assert.deepEqual(baseline(), before);
  writeFileSync(`${run}/evidence/schedule-labels.json`, JSON.stringify({ first, renamed, other, paused, resumed, before, after: baseline() }, null, 2));
  console.log(`PASS: live labels, target scoping, schedule facts, pause/resume and unchanged goal facts. ${run}/evidence/schedule-labels.json`);
} finally {
  db.close();
}
