import { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';

const [port, run] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: goal-own-session.ts <test-port> <run-dir>');
const db = new Database(`${run}/data/daemon.db`, { readonly: true });
const evidence: Record<string, unknown> = {};
const save = async () => {
  await mkdir(`${run}/evidence`, { recursive: true });
  await writeFile(`${run}/evidence/goal-own-session.json`, JSON.stringify(evidence, null, 2));
};
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
async function until<T>(read: () => T | null | undefined, message: string, timeout = 120000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = read();
    if (found) return found;
    await Bun.sleep(500);
  }
  await save();
  throw new Error(message);
}
const transcript = (sessionId: string) => db.query('SELECT sdk_uuid, sdk_message AS content FROM sdk_messages WHERE session_id = ? ORDER BY rowid').all(sessionId) as { sdk_uuid: string; content: string }[];

const root = (await rpc('neo.open', {})).sessionId;
const created = await rpc('goal.session.create', {
  ownerSessionId: root, title: 'Market the adapter guide', doneTest: 'Ten readers a week',
  cadence: { kind: 'every', everyMs: 60000 }, ownSession: true,
});
evidence.created = created;
assert(created.accepted, JSON.stringify(created));
const goalId = created.goal.id;
const owner = created.goal.ownerSessionId;
const session = db.query('SELECT id, title, status, parent_id AS parent_session_id FROM sessions WHERE id = ?').get(owner) as Record<string, string> | null;
evidence.session = session;
assert(owner !== root && session?.parent_session_id === root && session.title === 'Goal: Market the adapter guide', 'Goal did not start its own session under Neo');
const schedule = () => db.query("SELECT * FROM session_schedules WHERE source_kind = 'goal' AND source_id = ?").get(goalId) as Record<string, string> | null;
assert(JSON.parse(schedule()!.target).id === owner, 'Schedule does not target the goal session');
for (let index = 0; index < 10; index++)
  await rpc('goal.journal.append', { ownerSessionId: owner, goalId, runId: `seed-${index}`, done: `Seed ${index}`, effect: 'None yet', worked: 'Unknown' });

const wake = await until(() => transcript(owner).find((row) => row.sdk_uuid?.startsWith('schedule:') && row.content.includes('rewrite the what-works note')), 'No review wake reached the goal session');
evidence.wake = wake;
const runId = wake.sdk_uuid;
assert(wake.content.includes('This session owns the goal below.') && wake.content.includes(`runId ${runId}`) && !wake.content.includes('neo.home.read'), 'Wake did not carry the goal-session cycle');
evidence.schedule = schedule();
assert(!transcript(root).some((row) => row.content.includes(`goalId ${goalId}`)), 'The wake reached root Neo');

const entry = await until(() => db.query('SELECT * FROM goal_journal WHERE goal_id = ? AND run_id = ?').get(goalId, runId) as Record<string, string> | null, 'Goal session did not journal its run');
evidence.entry = entry;
assert(entry.session_id === owner && entry.effect === 'Three readers arrived', 'Journal entry is not from the goal session');
const note = await until(() => db.query('SELECT works_note FROM neo_goals WHERE id = ? AND works_note IS NOT NULL').get(goalId) as { works_note: string } | null, 'Goal session did not rewrite its what-works note');
evidence.note = note;
const review = await until(() => transcript(root).find((row) => row.content.includes(`Review of goal ${goalId}`)), 'Neo did not receive the review summary');
evidence.review = review;
assert(review.content.includes(owner), 'Review summary does not name the goal session');

const closed = await rpc('goal.session.update', { ownerSessionId: owner, goalId, status: 'completed' });
evidence.closed = closed;
assert(closed.goal?.status === 'completed' && !schedule(), 'Closing the goal kept its wake');
const released = db.query('SELECT id, status FROM sessions WHERE id = ?').get(owner) as Record<string, string> | null;
evidence.released = released;
assert(released?.status === 'active', 'Closing the goal removed its session');
await save();
console.log(`PASS: own goal session ${owner} woke, journaled ${runId}, rewrote its note, sent Neo the review; closing stopped wakes and kept the session. ${run}/evidence/goal-own-session.json`);
db.close();
