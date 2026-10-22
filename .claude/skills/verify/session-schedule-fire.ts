import { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';

const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: session-schedule-fire.ts <test-port> <run-dir>');
const db = new Database(`${run}/data/daemon.db`, { readonly: true });
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(`RPC failed: ${name}`);
  return output.reply;
}
const created = await rpc('rpc:session.create', { workspacePath: `${run}/home`, title: 'Scheduled reminder recipient' });
const sessionId = created.sessionId;
if (!sessionId) throw new Error(JSON.stringify(created));
const result = await rpc('schedule.session.create', {
  target: { adapter: 'hyperneo', id: sessionId }, cadence: { kind: 'every', everyMs: 60000 },
  note: 'Check the release checklist.',
});
const schedule = result.value?.schedule ?? result.schedule;
if (!schedule?.id) throw new Error(JSON.stringify(result));
console.log(`Waiting for reminder ${schedule.id} due ${new Date(schedule.nextRunAt).toISOString()}`);
let row: Record<string, unknown> | null = null;
const deadline = Date.now() + 80000;
while (Date.now() < deadline) {
  row = db.query('SELECT * FROM session_schedules WHERE id = ?').get(schedule.id) as Record<string, unknown>;
  if (row?.last_outcome) break;
  await Bun.sleep(1000);
}
if (row?.last_outcome === 'fired') {
  const deliveredBy = Date.now() + 10000;
  while (Date.now() < deliveredBy && !db.query('SELECT 1 FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?').get(sessionId, row.last_message_id)) await Bun.sleep(100);
}
const messages = db.query('SELECT * FROM sdk_messages WHERE session_id = ? AND message_type = ?').all(sessionId, 'user');
const jobs = db.query("SELECT status, run_at, error FROM job_queue WHERE queue = 'sessionSchedule.fire' AND json_extract(payload, '$.scheduleId') = ?").all(schedule.id);
const origins = db.query('SELECT * FROM session_schedule_wakes WHERE session_id = ?').all(sessionId);
const evidence = { sessionId, schedule: row, messages, jobs, origins };
await mkdir(`${run}/evidence`, { recursive: true });
await writeFile(`${run}/evidence/session-schedule-fire.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
await rpc('schedule.session.pause', { scheduleId: schedule.id });
if (row?.last_outcome !== 'fired' || row.due_count !== 0 || !row.last_message_id || !messages.some((m) => JSON.stringify(m).includes('daemon-note')) || messages.some((m) => JSON.stringify(m).includes('<session-message')) || !JSON.stringify(origins).includes(schedule.id) || Number(row.next_run_at) <= Number(row.last_run_at)) throw new Error('Reminder did not fire as a daemon note');
console.log('PASS: reminder fired as a daemon note; outcome and next cadence persisted.');
db.close();
