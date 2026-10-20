import { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: session-schedule-targets.ts <test-port> <run-dir>');
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(`RPC failed: ${name}`);
  return output.reply;
}
const db = new Database(`${run}/data/daemon.db`, { readonly: true });
const created = await rpc('rpc:session.create', { workspacePath: `${run}/home`, title: 'Archive before reminder' });
const sessionId = created.sessionId;
if (!sessionId) throw new Error(JSON.stringify(created));
const ids: string[] = [];
for (const id of [sessionId, `missing-${crypto.randomUUID()}`]) {
  const result = await rpc('schedule.session.create', { target: { adapter: 'hyperneo', id }, cadence: { kind: 'every', everyMs: 60000 }, note: 'Do not wake a closed session.' });
  const schedule = result.value?.schedule ?? result.schedule;
  if (!schedule?.id) throw new Error(JSON.stringify(result));
  ids.push(schedule.id);
}
console.log(JSON.stringify(await rpc('rpc:session.archive', { sessionId, confirmed: true })));
let rows: Record<string, unknown>[] = [];
const deadline = Date.now() + 80000;
while (Date.now() < deadline) {
  rows = ids.map((id) => db.query('SELECT * FROM session_schedules WHERE id = ?').get(id) as Record<string, unknown>);
  if (rows.every((r) => r.last_outcome === 'target_gone')) break;
  await Bun.sleep(1000);
}
const jobs = ids.flatMap((id) => db.query("SELECT status, retry_count, error FROM job_queue WHERE queue = 'sessionSchedule.fire' AND json_extract(payload, '$.scheduleId') = ?").all(id));
const messages = db.query('SELECT * FROM sdk_messages WHERE session_id = ?').all(sessionId);
const evidence = { rows, jobs, messages };
await mkdir(`${run}/evidence`, { recursive: true });
await writeFile(`${run}/evidence/session-schedule-targets.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
for (const id of ids) await rpc('schedule.session.delete', { scheduleId: id });
if (!rows.every((r) => r.status === 'done' && r.last_outcome === 'target_gone' && r.pending_job_id === null) || messages.length) throw new Error('Closed targets must complete without delivery');
console.log('PASS: archived and missing targets complete without delivery or retries.');
db.close();
