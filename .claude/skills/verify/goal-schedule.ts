import { NEO_GOAL_CYCLE } from '../../../packages/prompts/src/mod.ts';
import { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';

const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: goal-schedule.ts <test-port> <run-dir>');
const db = new Database(`${run}/data/daemon.db`, { readonly: true });
const evidence: Record<string, unknown> = {};
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited || output.reply?.error) throw new Error(JSON.stringify(output));
  return output.reply;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until<T>(read: () => T | null | undefined, message: string, timeout = 90000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = read();
    if (found) return found;
    await Bun.sleep(500);
  }
  throw new Error(message);
}
const root = (await rpc('neo.open', {})).sessionId;
const created = await rpc('goal.session.create', {
  ownerSessionId: root, title: 'Publish the adapter guide', doneTest: 'Guide published',
  mandateRef: 'mandate.md#guides', cadence: { kind: 'every', everyMs: 60000 }, nudgeEvery: 4,
});
assert(created.accepted, JSON.stringify(created));
const goalId = created.goal.id;
evidence.created = created;
const schedule = () => db.query("SELECT * FROM session_schedules WHERE source_kind = 'goal' AND source_id = ?").get(goalId) as Record<string, unknown> | null;
assert(schedule()?.status === 'active', 'Goal did not create its schedule');
await rpc('neo.message.send', { sessionId: root, requestId: crypto.randomUUID(), content: `verify-goal-ask:${goalId}` });
const ask = await until(() => db.query('SELECT * FROM neo_asks WHERE goal_id = ?').get(goalId), 'Mock Neo did not open the goal-linked ask');
evidence.ask = ask;
const read = () => rpc('goal.facts', { ownerSessionId: root, goalId });
const first = await read();
assert(first.facts.summary.includes('Publish guide'), JSON.stringify(first));
assert(JSON.stringify(await read()) === JSON.stringify(first), 'A facts read consumed its summary');
evidence.before = first;
await until(() => {
  const row = schedule();
  return row?.last_outcome === 'fired' ? row : null;
}, 'Goal wake did not fire');
const delivered = schedule()!;
evidence.fired = delivered;
const message = await until(() => db.query('SELECT * FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?').get(root, delivered.last_message_id), 'Wake missing from transcript');
evidence.message = message;
const serialized = JSON.stringify(message);
assert(serialized.includes('daemon-note') && serialized.includes(NEO_GOAL_CYCLE.split('\n')[0]) && serialized.includes('mandate.md#guides') && serialized.includes(`goalId ${goalId}`) && serialized.includes(`runId ${delivered.last_message_id}`), 'Wake omitted goal context or run id');
const after = await read();
evidence.after = after;
assert(after.facts.summary === '' && /^[0-9a-f]{64}$/.test(String(delivered.facts_digest)), 'Delivery did not atomically save its goal baseline and schedule progress digest');
await rpc('goal.session.update', { ownerSessionId: root, goalId, progress: 40 });
const changed = await read();
evidence.changed = changed;
assert(changed.facts.summary === '- Progress: 0\n+ Progress: 40', JSON.stringify(changed));
const update = (status: string) => rpc('goal.session.update', { ownerSessionId: root, goalId, status });
await rpc('schedule.session.pause', { scheduleId: delivered.id });
await rpc('goal.session.update', { ownerSessionId: root, goalId, progress: 50 });
evidence.manualPause = schedule();
assert(schedule()?.status === 'paused', 'A progress update undid a manual schedule pause');
await update('paused');
evidence.paused = schedule();
assert(schedule()?.status === 'paused' && schedule()?.pending_job_id === null, 'Pause left a scheduled job');
await update('active');
evidence.resumed = schedule();
assert(schedule()?.status === 'active' && schedule()?.pending_job_id, 'Resume did not restore cadence');
await update('completed');
evidence.completed = await read();
assert(!schedule() && (evidence.completed as { facts: unknown }).facts === null, 'Closed goal retained a schedule or live facts');
evidence.root = root;
await mkdir(`${run}/evidence`, { recursive: true });
await writeFile(`${run}/evidence/goal-schedule.json`, JSON.stringify(evidence, null, 2));
console.log(`PASS: goal-linked ask, delivered wake, read-safe facts delta, pause/resume and completion. ${run}/evidence/goal-schedule.json`);
db.close();
