import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const [portText, runText, mode = 'all'] = process.argv.slice(2);
assert(runText);
const run = resolve(runText), port = Number(portText);
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')), 'fresh synthetic DB required');
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'home/.gitconfig'), '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: Record<string, any> = { operations: [] };
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const rpc = (name: string, input: unknown = {}) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(); const timer = setTimeout(() => fail(new Error(`RPC timeout: ${name}`)), 10000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); evidence.operations.push({ name, input, reply });
      done(reply.error ? { rpcError: reply.error } : reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const ownerSessionId = (await rpc('neo.open')).sessionId;
  assert(ownerSessionId);
  const db = app.db.getDatabase();
  if (mode === 'wake' || mode === 'nudge') {
    const goal = (await rpc('goal.session.create', {ownerSessionId,title:'Verify compaction wake',doneTest:'Guide published',nudgeEvery:1})).goal;
    assert(goal);
    const input={ownerSessionId,goalId:goal.id};
    for(let i=0;i<(mode==='wake'?10:0);i++) await rpc('goal.journal.append',{...input,runId:`cycle-${i}`,done:`Cycle ${i}`,effect:'A reader tried it',worked:'Small examples'});
    const facts=(await rpc('goal.facts',input)).facts;
    const schedule=db.prepare("SELECT * FROM session_schedules WHERE source_id=? AND source_kind='goal'").get(goal.id) as any;
    const due=Date.now();
    if(mode==='nudge') db.prepare('UPDATE session_schedules SET facts_digest=? WHERE id=?').run(facts.digest,schedule.id);
    db.prepare('UPDATE session_schedules SET next_run_at=? WHERE id=?').run(due,schedule.id);
    app.jobQueue.reschedulePending(schedule.pending_job_id,due);
    const messageId=`schedule:${schedule.id}:${due}`;
    let payload:string | undefined;
    for(let i=0;i<100&&!payload;i++) {
      payload=(db.prepare("SELECT payload FROM job_queue WHERE queue='mailbox' AND json_extract(payload,'$.messageUuid')=?").get(messageId) as {payload:string}|null)?.payload;
      if(!payload) await Bun.sleep(200);
    }
    evidence.mode=mode; evidence.facts=facts; evidence.mailbox=payload?JSON.parse(payload):null;
    evidence.schedule=db.prepare('SELECT last_outcome,last_message_id FROM session_schedules WHERE id=?').get(schedule.id);
    assert(payload,'Scheduled wake was not delivered to the actual mailbox');
    assert(payload.includes('rewrite')&&payload.includes('worksNote'),'Model-facing wake omitted compaction instruction');
    assert.equal(evidence.schedule.last_outcome,'fired');
    if(mode==='nudge') assert(payload.includes('Nothing moved'));
    console.log(`PASS: actual ${mode} schedule delivered a compaction request to Neo mailbox`);
  } else {
  new NeoAskTodoRepository(db).openAsk({ id: 'synthetic-confirmation', sessionId: ownerSessionId, projectId: null, originMessageId: null, title: 'Review mandate', request: 'Synthetic G8 verification', createdAt: Date.now() });
  assert((await rpc('neo.home.init')).ok);
  const git = async (...args: string[]) => {
    const process = Bun.spawn(['git', ...args], { cwd: join(run, 'data/Neo'), stdout: 'pipe', stderr: 'pipe' });
    const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    assert.equal(code, 0, error); return output.trim();
  };
  const path = 'projects/synthetic/mandate.md';
  const save = async (content: string, answer: 'yes' | 'no') => {
    const confirm = { path, sha256: createHash('sha256').update(content).digest('hex') };
    const question = await rpc('neo.question.ask', { askId: 'synthetic-confirmation', kind: 'yesno', text: `Replace the mandate with:\n${content}\nPath: ${path}\nSHA-256: ${confirm.sha256}`, noLabel: 'Keep current mandate', yesLabel: 'Adopt this mandate', confirm });
    assert(question.ok, JSON.stringify(question));
    await rpc('neo.question.answer', { questionId: question.question.id, answer });
    return rpc('neo.home.save', { path, content, message: 'Confirmed synthetic mandate', questionId: question.question.id });
  };
  const initial = await save('Publish one useful guide.\n', 'yes');
  assert(initial.ok, JSON.stringify(initial));
  const goal = (await rpc('goal.session.create', { ownerSessionId, title: 'Useful guide', doneTest: 'Guide published', mandateRef: `${path}#guide`, mandateRev: initial.commit, nudgeEvery: 1 })).goal;
  assert(goal);
  const input = { ownerSessionId, goalId: goal.id };
  evidence.before = await rpc('goal.facts', input);
  const declined = await save('Publish ten guides.\n', 'no');
  assert(!declined.ok);
  assert.equal(await git('rev-parse', 'HEAD'), initial.commit);
  assert.equal(readFileSync(join(run, 'data/Neo', path), 'utf8'), 'Publish one useful guide.\n');
  assert.deepEqual(await rpc('goal.facts', input), evidence.before);
  const changed = await save('Publish two useful guides.\n', 'yes');
  assert(changed.ok);
  evidence.mandateChanged = await rpc('goal.facts', input);
  evidence.mandateReadStable = await rpc('goal.facts', input);
  const mandateDetected = evidence.mandateChanged.facts.lines.some((line: string) => line.startsWith('Mandate changed:') && line.includes(changed.commit));
  assert.deepEqual(evidence.mandateReadStable, evidence.mandateChanged);
  assert((await rpc('goal.journal.append', { ...input, done: 'Reconciled the confirmed mandate', effect: 'Target is two guides', worked: 'Kept human approval', evidence: [{ kind: 'commit', ref: changed.commit }] })).accepted);
  await rpc('goal.session.update', { ...input, mandateRev: changed.commit });
  evidence.reconciled = await rpc('goal.facts', input);
  assert(!evidence.reconciled.facts.lines.some((line: string) => line.startsWith('Mandate changed:')));
  assert.equal(await git('rev-parse', 'HEAD'), changed.commit, 'Goals must never author a home commit');
  for (let i = 1; i < 9; i++) await rpc('goal.journal.append', { ...input, runId: `cycle-${i}`, done: `Cycle ${i}`, effect: 'A reader tried the guide', worked: 'Small examples' });
  evidence.nine = await rpc('goal.facts', input);
  await rpc('goal.journal.append', { ...input, runId: 'cycle-9', done: 'Tenth cycle', effect: 'Another reader', worked: 'Keep examples small' });
  evidence.ten = await rpc('goal.facts', input);
  const compactionDetected = evidence.ten.facts.lines.includes('What-works compaction due');
  evidence.compacted = await rpc('goal.session.update', { ...input, worksNote: 'Small concrete examples help readers try the guide.' });
  evidence.goal = await rpc('goal.session.get', input);
  evidence.journal = await rpc('goal.journal.list', input);
  evidence.cursor = db.prepare('SELECT works_note_through FROM neo_goals WHERE id=?').get(goal.id);
  evidence.events = db.prepare("SELECT event_type,source,new_state FROM space_goal_events WHERE goal_id=? AND event_type='journal_compacted'").all(goal.id);
  evidence.finalHomeHead = await git('rev-parse', 'HEAD');
  evidence.checks = { mandateDetected, compactionDetected, noteSaved: evidence.compacted.accepted === true, historyKept: evidence.journal.entries.length === 10, cursorSaved: evidence.cursor.works_note_through === 10, noSpaceEvents: evidence.events.length === 0, homeUntouched: evidence.finalHomeHead === changed.commit };
  assert(Object.values(evidence.checks).every(Boolean), JSON.stringify(evidence.checks));
  console.log(`PASS: actual RPC compaction, preserved journal and confirmed-only mandate reconciliation. ${run}/evidence/goal-what-works.json`);
  }
} finally {
  writeFileSync(join(run, 'evidence/goal-what-works.json'), JSON.stringify(evidence, null, 2));
  ws?.close(); await app.cleanup();
}
