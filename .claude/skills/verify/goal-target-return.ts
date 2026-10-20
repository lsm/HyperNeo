import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const db = new Database(`${run}/data/daemon.db`, { readonly: true });
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  return result.reply;
}
async function until<T>(read: () => T | null | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await Bun.sleep(500);
  }
  throw new Error(message);
}
const ownerSessionId = (await rpc('rpc:session.create', { workspacePath: `${run}/home`, title: 'Returning goal owner' })).sessionId;
assert(ownerSessionId);
const cadence = { kind: 'every', everyMs: 60000 };
const created = await rpc('goal.session.create', { ownerSessionId, title: 'Recover the guide wake', doneTest: 'Published', cadence, nudgeEvery: 7 });
assert(created.accepted, JSON.stringify(created));
const goalId = created.goal.id;
const target = { adapter: 'hyperneo', id: ownerSessionId };
const listed = async () => (await rpc('schedule.session.list', { target })).schedules.find((row: { sourceId: string }) => row.sourceId === goalId);
await rpc('rpc:session.archive', { sessionId: ownerSessionId, confirmed: true });
const gone = await until(() => {
  const row = db.query("SELECT * FROM session_schedules WHERE source_kind = 'goal' AND source_id = ?").get(goalId) as { last_outcome: string } | null;
  return row?.last_outcome === 'target_gone' ? row : null;
}, 'Archived owner did not finish as target_gone');
await rpc('rpc:session.update', { sessionId: ownerSessionId, status: 'active', archivedAt: null });
await rpc('goal.session.update', { ownerSessionId, goalId, status: 'paused' });
const paused = await listed();
await rpc('goal.session.update', { ownerSessionId, goalId, status: 'active' });
const restored = await listed();
const evidence: Record<string, unknown> = { ownerSessionId, goalId, gone, paused, restored };
const save = () => writeFileSync(`${run}/evidence/goal-target-return.json`, JSON.stringify(evidence, null, 2));
save();
assert.equal(restored?.status, 'active');
assert(restored.pendingJobId);
assert.deepEqual(restored.cadence, cadence);
assert.equal(restored.nudgeEvery, 7);
const delivered = await until(() => {
  const row = db.query('SELECT * FROM session_schedules WHERE id = ?').get(restored.id) as { last_outcome: string; last_message_id: string } | null;
  return row?.last_outcome === 'fired' ? row : null;
}, 'Restored goal did not deliver its next wake');
const message = await until(() => db.query('SELECT * FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?').get(ownerSessionId, delivered.last_message_id), 'Wake not visible in the transcript');
Object.assign(evidence, { delivered, message });
save();
assert(JSON.stringify(message).includes('Recover the guide wake'));
await rpc('goal.session.update', { ownerSessionId, goalId, status: 'completed' });
db.close();
console.log(`PASS: archived owner returned, goal reactivated, configured wake delivered. ${run}/evidence/goal-target-return.json`);
