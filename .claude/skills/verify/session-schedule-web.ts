import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const response = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!response.reply.error, JSON.stringify(response));
  return response.reply;
}
const root = (await rpc('neo.open', {})).sessionId;
const worker = (await rpc('rpc:session.create', { workspacePath: '/tmp', title: 'Schedule worker' })).sessionId;
mkdirSync(`${run}/workspace`, { recursive: true });
const space = await rpc('rpc:space.create', { name: 'Schedule scope', workspacePath: `${run}/workspace`, seedAgentTemplateKeys: [] });
assert(space.id, JSON.stringify(space));
writeFileSync(`${run}/evidence/schedule-web-space.json`, JSON.stringify({ spaceId: space.id, worker }, null, 2));
const surfaces = [];
for (const [name, sessionId, title] of [['neo', root, 'Ship root guide'], ['session', worker, 'Publish worker notes']]) {
  const target = { adapter: 'hyperneo', id: sessionId };
  const goal = await rpc('goal.session.create', {
    ownerSessionId: sessionId, title, description: `Definition of ${title}`,
    doneTest: 'Guide publicly available', cadence: { kind: 'every', everyMs: 3600000 }, nudgeEvery: 4,
  });
  assert(goal.accepted, JSON.stringify(goal));
  const listed = await rpc('schedule.session.list', { target });
  const schedule = listed.schedules.find((row: { sourceId: string }) => row.sourceId === goal.goal.id);
  const reminder = await rpc('schedule.session.create', {
    target, cadence: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }, note: `Daily ${name} reminder`,
  });
  assert(reminder.ok, JSON.stringify(reminder));
  assert((await rpc('schedule.session.pause', { scheduleId: reminder.schedule.id })).ok);
  surfaces.push({ name, sessionId, title, scheduleId: schedule.id, reminderId: reminder.schedule.id });
}
const db = new Database(`${run}/data/daemon.db`);
try {
  db.exec('PRAGMA busy_timeout=5000');
  for (const surface of surfaces) db.query(`UPDATE session_schedules SET last_run_at = ?, last_outcome = 'skipped_busy', last_skip_reason = 'busy', due_count = ? WHERE id = ?`).run(Date.now() - 60000, surface.name === 'neo' ? 6 : 2, surface.scheduleId);
} finally { db.close(); }
writeFileSync(`${run}/evidence/schedule-web-seed.json`, JSON.stringify(surfaces, null, 2));
console.log(`Seeded synthetic schedule facts (last outcomes are fixtures, not real deliveries). ${run}/evidence/schedule-web-seed.json`);
