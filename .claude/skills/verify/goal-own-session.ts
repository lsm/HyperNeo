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
const otherOwner = (await rpc('rpc:session.create', { workspacePath: run, title: 'Independent goal owner' })).sessionId;
const other = await rpc('goal.session.create', { ownerSessionId: otherOwner, title: 'Independent goal', doneTest: 'Done', reviewCadence: { kind: 'every', everyMs: 60000 } });
assert(other.accepted, 'Could not create an independent goal');
const created = await rpc('goal.session.create', {
  ownerSessionId: root, title: 'Market the adapter guide', doneTest: 'Ten readers a week',
  cadence: { kind: 'every', everyMs: 60000 }, reviewCadence: { kind: 'every', everyMs: 90000 }, ownSession: true,
});
evidence.created = created;
assert(created.accepted, JSON.stringify(created));
const goalId = created.goal.id;
const owner = created.goal.ownerSessionId;
const session = db.query('SELECT id, title, status, parent_id AS parent_session_id FROM sessions WHERE id = ?').get(owner) as Record<string, string> | null;
evidence.session = session;
assert(owner !== root && session?.parent_session_id === root && session.title === 'Goal: Market the adapter guide', 'Goal did not start its own session under Neo');
const schedule = () => db.query("SELECT * FROM session_schedules WHERE source_kind = 'goal' AND source_id = ?").get(goalId) as Record<string, string> | null;
const reviewSchedule = () => db.query("SELECT * FROM session_schedules WHERE source_kind = 'goal_review' AND source_id = ?").get(goalId) as Record<string, string> | null;
assert(JSON.parse(schedule()!.target).id === owner, 'Schedule does not target the goal session');
assert(JSON.parse(reviewSchedule()!.target).id === owner, 'Review schedule does not target the goal session');
const isWake = (row: { sdk_uuid: string }) => row.sdk_uuid?.startsWith('schedule:');
const returns = () => transcript(root).filter((row) => row.content.includes('分身 returned'));
const journaled = (runId: string) => until(() => db.query('SELECT * FROM goal_journal WHERE goal_id = ? AND run_id = ?').get(goalId, runId) as Record<string, string> | null, `Goal session did not journal ${runId}`);
const finished = (text: string) => until(() => transcript(owner).find((row) => row.content.includes(text)), `Goal session turn did not end with "${text}"`);
assert(!transcript(root).some((row) => row.content.includes(`goalId ${goalId}`)), 'A wake reached root Neo');


const work = await until(() => transcript(owner).find(isWake), 'No work wake reached the goal session');
evidence.workWake = work;
assert(work.content.includes('This session owns the goal below.') && work.content.includes(`runId ${work.sdk_uuid}`) && !work.content.includes('neo.home.read') && !work.content.includes('Read the journal pages and rewrite'), 'First wake was not a plain goal-session work wake');
const workEntry = await journaled(work.sdk_uuid);
evidence.workEntry = workEntry;
assert(workEntry.session_id === owner, 'Work journal entry is not from the goal session');
evidence.returnsAfterWork = returns().length;
assert(returns().length === 0, 'An ordinary work run reported to Neo');
await finished('Journaled the work run.');
const dueReview = db.query("SELECT last_outcome FROM session_schedules WHERE source_kind = 'goal_review' AND source_id = ?").get(goalId) as { last_outcome: string } | null;
assert(dueReview?.last_outcome === 'fired', 'Review did not fire while the work turn was running');

const wake = await until(() => transcript(owner).find((row) => isWake(row) && row.content.includes('Journal entries since the previous review')), 'No review wake reached the goal session', 180000);
evidence.reviewWake = wake;
const runId = /runId (goal-review:[^, ]+)/.exec(wake.content)?.[1];
assert(runId, 'Review wake lacks its journal run id');
assert(wake.content.includes(`runId ${runId}`) && wake.content.includes('Posted the guide in two forums'), 'Review wake did not carry the prior journal entry');
evidence.schedule = schedule();
const entry = await journaled(runId);
evidence.entry = entry;
assert(entry.session_id === owner && entry.effect === 'yes', 'Review journal entry is not from the goal session');
const journal = await rpc('goal.journal.list', { ownerSessionId: owner, goalId });
assert(journal.entries.some((item: { runId: string; done: string; effect: string }) => item.runId === runId && item.done.includes('Review:') && item.effect === 'yes'), 'Review result is not readable from the journal');
const listed = await rpc('schedule.session.list', { target: { adapter: 'hyperneo', id: owner } });
assert(listed.schedules.filter((item: { sourceId: string }) => item.sourceId === goalId).length === 2, 'Both schedules are not readable');
const note = await until(() => db.query('SELECT works_note FROM neo_goals WHERE id = ? AND works_note IS NOT NULL').get(goalId) as { works_note: string } | null, 'Goal session did not rewrite its what-works note');
evidence.note = note;
const review = await until(() => transcript(root).find((row) => row.content.includes(`Review of goal ${goalId}`)), 'Neo did not receive the review summary');
evidence.review = review;
await finished('Journaled the run; review sent to Neo.');
evidence.returnsAfterReview = returns().length;
assert(review.content.includes(owner) && returns().length === 1, 'Neo did not receive exactly the review summary');
assert(!transcript(root).some((row) => row.content.includes(`goalId ${goalId}`)), 'A wake reached root Neo');

const otherReview = await until(() => transcript(root).find((row) => row.content.includes(`Review of goal ${other.goal.id}`)), 'Neo did not receive the independent goal review');
evidence.independentReview = otherReview;
const otherJournal = await rpc('goal.journal.list', { ownerSessionId: otherOwner, goalId: other.goal.id });
assert(otherJournal.entries.some((item: { runId: string | null; effect: string }) => item.runId?.startsWith('goal-review:') && item.effect === 'yes'), 'Independent review was not journaled');

const closed = await rpc('goal.session.update', { ownerSessionId: owner, goalId, status: 'completed' });
evidence.closed = closed;
assert(closed.goal?.status === 'completed' && !schedule() && !reviewSchedule(), 'Closing the goal kept a wake');
const released = db.query('SELECT id, status FROM sessions WHERE id = ?').get(owner) as Record<string, string> | null;
evidence.released = released;
assert(released?.status === 'active', 'Closing the goal removed its session');
await save();
console.log(`PASS: own goal session ${owner} ran a work wake with nothing sent to Neo, then a review wake (${runId}) that rewrote its note and sent Neo only the review; closing stopped wakes and kept the session. ${run}/evidence/goal-own-session.json`);
db.close();
