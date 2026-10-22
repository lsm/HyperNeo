import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const db = new Database(`${run}/data/daemon.db`);
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
assert(ownerSessionId.startsWith('neo:'));
const created = await rpc('goal.session.create', { ownerSessionId, title: 'Wake despite unreadable state', doneTest: 'Published', cadence: { kind: 'every', everyMs: 60000 } });
assert(created.accepted, JSON.stringify(created));
const goalId = created.goal.id;
const previous = db.query('SELECT processing_state FROM sessions WHERE id = ?').get(ownerSessionId) as { processing_state: string | null };
try {
  db.query('UPDATE sessions SET processing_state = ? WHERE id = ?').run('{', ownerSessionId);
  const deadline = Date.now() + 90000;
  let schedule: Record<string, unknown> | undefined;
  let jobs: Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    schedule = db.query("SELECT * FROM session_schedules WHERE source_kind = 'goal' AND source_id = ?").get(goalId) as Record<string, unknown>;
    jobs = db.query("SELECT status,error,retry_count FROM job_queue WHERE queue = 'sessionSchedule.fire' AND json_extract(payload,'$.scheduleId') = ?").all(schedule.id as string) as Record<string, unknown>[];
    if (schedule.last_outcome || jobs.some((job) => job.error)) break;
    await Bun.sleep(500);
  }
  const listed = await rpc('schedule.session.list', { target: { adapter: 'hyperneo', id: ownerSessionId } });
  const messages = db.query('SELECT * FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?').all(ownerSessionId, String(schedule?.last_message_id ?? ''));
  writeFileSync(`${run}/evidence/goal-unreadable-state.json`, JSON.stringify({ ownerSessionId, goalId, schedule, jobs, listed, messages }, null, 2));
  assert.equal(schedule?.last_outcome, 'fired');
  assert.equal(schedule?.status, 'active');
  assert(!jobs.some((job) => job.error));
  assert(db.query('SELECT * FROM session_schedule_wakes WHERE message_id = ?').get(String(schedule?.last_message_id)));
  console.log(`PASS: open Neo with unreadable processing state delivered its goal wake. ${run}/evidence/goal-unreadable-state.json`);
} finally {
  db.query('UPDATE sessions SET processing_state = ? WHERE id = ?').run(previous.processing_state, ownerSessionId);
  await rpc('goal.session.update', { ownerSessionId, goalId, status: 'completed' });
  db.close();
}
