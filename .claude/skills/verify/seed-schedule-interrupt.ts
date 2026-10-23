import { Database } from 'bun:sqlite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: seed-schedule-interrupt.ts <test-port> <run-dir>');
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const output = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(`RPC failed: ${name}`);
  return output.reply;
}
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Refusing a non-test database');
const db = new Database(`${run}/data/daemon.db`);
const created = await rpc('rpc:session.create', { workspacePath: `${run}/home`, title: 'Interrupted reminder recipient' });
const sessionId = created.sessionId;
if (!sessionId) throw new Error(JSON.stringify(created));
const result = await rpc('schedule.session.create', { target: { adapter: 'hyperneo', id: sessionId }, cadence: { kind: 'every', everyMs: 60000 }, note: 'Keep this schedule after interrupt.' });
const schedule = result.value?.schedule ?? result.schedule;
if (!schedule?.id) throw new Error(JSON.stringify(result));
db.query('UPDATE sessions SET processing_state = ? WHERE id = ?').run(JSON.stringify({ status: 'interrupted', reason: 'user' }), sessionId);
const before = await rpc('work.status', { ref: { adapter: 'hyperneo', id: sessionId } });
console.log(JSON.stringify({ before }));
let row: Record<string, unknown> | null = null;
const deadline = Date.now() + 80000;
while (Date.now() < deadline) {
  row = db.query('SELECT * FROM session_schedules WHERE id = ?').get(schedule.id) as Record<string, unknown>;
  if (row?.last_outcome) break;
  await Bun.sleep(1000);
}
const listed = await rpc('schedule.session.list', { target: { adapter: 'hyperneo', id: sessionId } });
const messages = db.query('SELECT * FROM sdk_messages WHERE session_id = ?').all(sessionId);
const evidence = { before, listed, row, messages };
await mkdir(`${run}/evidence`, { recursive: true });
await writeFile(`${run}/evidence/session-schedule-interrupt.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
await rpc('schedule.session.delete', { scheduleId: schedule.id });
if (row?.status !== 'active' || row.last_outcome !== 'skipped_busy' || row.due_count !== 0 || Number(row.next_run_at) <= Date.now() || messages.length) throw new Error('Interrupt must skip to the next cadence without completing the schedule');
console.log('PASS: open interrupted session keeps its active schedule and advances the cadence.');
db.close();
