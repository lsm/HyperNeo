import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const [port, run, existingGoalId] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  return result.reply;
}
const ownerSessionId = (await rpc('neo.open', {})).sessionId;
const cadence = { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' };
const created = existingGoalId ? { accepted: true, goal: { id: existingGoalId } } : await rpc('goal.session.create', { ownerSessionId, title: 'Daily guide', doneTest: 'Published', cadence, nudgeEvery: 7 });
assert(created.accepted, JSON.stringify(created));
const goalId = created.goal.id;
const evidence: unknown[] = [];
for (const status of ['completed', 'archived']) {
  assert((await rpc('goal.session.update', { ownerSessionId, goalId, status })).accepted);
  const closed = await rpc('schedule.session.list', { target: { adapter: 'hyperneo', id: ownerSessionId } });
  assert(!closed.schedules.some((row: { sourceId: string }) => row.sourceId === goalId));
  assert((await rpc('goal.session.update', { ownerSessionId, goalId, status: 'active' })).accepted);
  const listed = await rpc('schedule.session.list', { target: { adapter: 'hyperneo', id: ownerSessionId } });
  const reopened = listed.schedules.find((row: { sourceId: string }) => row.sourceId === goalId);
  evidence.push({ status, goalId, expected: { cadence, nudgeEvery: 7 }, reopened });
  writeFileSync(`${run}/evidence/goal-reopen.json`, JSON.stringify(evidence, null, 2));
  assert.deepEqual(reopened?.cadence, cadence);
  assert.equal(reopened.nudgeEvery, 7);
}
await rpc('goal.session.update', { ownerSessionId, goalId, status: 'completed' });
console.log(`PASS: completed and archived goal reopen preserves cadence/nudgeEvery. ${run}/evidence/goal-reopen.json`);
