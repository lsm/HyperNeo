import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SessionGoalSchedules } from '../../../packages/daemon/src/lib/goals/session-goal-schedules.ts';

const [port, directory] = process.argv.slice(2);
assert(Number(port) > 0 && port !== '8399' && directory);
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath));
for (const name of ['home', 'data', 'evidence']) mkdirSync(join(run, name), { recursive: true });
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  return result.reply;
}
let closing: { goalId: string; ownerSessionId: string } | null = null;
let observed: { result?: string | null; error?: string } | null = null;
const facts = SessionGoalSchedules.prototype.facts;
const message = SessionGoalSchedules.prototype.message;
SessionGoalSchedules.prototype.facts = async function (id) {
  const snapshot = await facts.call(this, id);
  if (closing?.goalId === id) {
    const target = closing;
    closing = null;
    assert((await rpc('goal.session.update', { ...target, status: 'completed' })).accepted);
  }
  return snapshot;
};
SessionGoalSchedules.prototype.message = function (id, change) {
  try {
    const result = message.call(this, id, change);
    observed = { result };
    return result;
  } catch (error) {
    observed = { error: error instanceof Error ? error.message : String(error) };
    throw error;
  }
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: Number(port), host: '127.0.0.1', dbPath }), verbose: false });
  const ownerSessionId = (await rpc('neo.open', {})).sessionId;
  const created = await rpc('goal.session.create', { ownerSessionId, title: 'Close while facts load', doneTest: 'Published', cadence: { kind: 'every', everyMs: 60000 } });
  assert(created.accepted, JSON.stringify(created));
  const goalId = created.goal.id;
  closing = { goalId, ownerSessionId };
  const deadline = Date.now() + 90000;
  while (!observed && Date.now() < deadline) await Bun.sleep(100);
  await Bun.sleep(100);
  const goal = await rpc('goal.session.get', { ownerSessionId, goalId });
  const schedules = await rpc('schedule.session.list', { target: { adapter: 'hyperneo', id: ownerSessionId } });
  const wakes = app.db.getDatabase().prepare('SELECT metadata_json FROM session_schedule_wakes WHERE session_id = ?').all(ownerSessionId).filter((row: { metadata_json: string | null }) => row.metadata_json?.includes(goalId));
  writeFileSync(join(run, 'evidence/goal-close-race.json'), JSON.stringify({ goalId, observed, goal, schedules, wakes }, null, 2));
  assert(observed, 'The real cadence did not reach message rendering');
  assert.equal(observed.error, undefined);
  assert.equal(observed.result, null);
  assert.equal(goal.goal.status, 'completed');
  assert(!schedules.schedules.some((row: { sourceId: string }) => row.sourceId === goalId));
  assert.deepEqual(wakes, []);
  console.log(`PASS: real RPC completion during fact collection retires the wake without throwing. ${run}/evidence/goal-close-race.json`);
} finally {
  await app?.cleanup();
  SessionGoalSchedules.prototype.facts = facts;
  SessionGoalSchedules.prototype.message = message;
}
