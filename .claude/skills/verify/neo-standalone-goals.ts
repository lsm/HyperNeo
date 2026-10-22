import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const name of ['home', 'data', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const evidence: Record<string, any> = { operations: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
}
const rpc = (name: string, input: unknown = {}) => new Promise<any>((done, fail) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => fail(new Error(`RPC timeout: ${name}`)), 15000);
  ws!.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id !== id && reply.requestId !== id) return;
    clearTimeout(timer); evidence.operations.push({ name, input, reply });
    if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
  };
  ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
try {
  await open();
  const ownerSessionId = (await rpc('neo.open')).sessionId;
  const created = await rpc('goal.session.create', { ownerSessionId, title: 'Independent guide', doneTest: 'Guide published', cadence: { kind: 'every', everyMs: 900000 }, nudgeEvery: 2 });
  assert(created.accepted, JSON.stringify(created));
  const input = { ownerSessionId, goalId: created.goal.id };
  const db = app!.db.getDatabase();
  evidence.storage = {
    spaceGoals: db.prepare('SELECT COUNT(*) AS n FROM space_goals').get(),
    spaceEvents: db.prepare('SELECT COUNT(*) AS n FROM space_goal_events').get(),
    hasNeoGoals: !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='neo_goals'").get(),
  };
  assert.deepEqual(evidence.storage, { spaceGoals: { n: 0 }, spaceEvents: { n: 0 }, hasNeoGoals: true });
  const ask = new NeoAskTodoRepository(db).openAsk({ id: 'synthetic-ask', sessionId: ownerSessionId, projectId: null, goalId: input.goalId, originMessageId: null, title: 'Goal-owned ask', request: 'Retain this association', createdAt: Date.now() });
  evidence.ask = { ask: new NeoAskTodoRepository(db).getAsk(ask.id) };
  assert.equal(evidence.ask.ask.goalId, input.goalId);
  for (let i = 0; i < 10; i++) assert((await rpc('goal.journal.append', { ...input, runId: `run-${i}`, done: `Cycle ${i}`, effect: 'Reader tried it', worked: 'Examples' })).accepted);
  assert((await rpc('goal.journal.append', { ...input, runId: 'run-9', done: 'Retried last cycle', effect: 'Reader tried it', worked: 'Examples' })).accepted);
  assert((await rpc('goal.session.update', { ...input, worksNote: 'Examples help', progress: 40 })).accepted);
  evidence.goal = await rpc('goal.session.get', input);
  evidence.journal = await rpc('goal.journal.list', input);
  evidence.facts = await rpc('goal.facts', input);
  evidence.cursor = db.prepare('SELECT works_note_through FROM neo_goals WHERE id=?').get(input.goalId);
  assert.equal(evidence.goal.goal.worksNote, 'Examples help');
  assert.equal(evidence.journal.entries.length, 10);
  assert.equal(evidence.cursor.works_note_through, 10);
  assert((await rpc('goal.session.update', { ...input, status: 'completed' })).accepted);
  assert((await rpc('goal.session.update', { ...input, status: 'active' })).accepted);
  evidence.schedules = await rpc('schedule.session.list', { target: { adapter: 'hyperneo', id: ownerSessionId } });
  const schedule = evidence.schedules.schedules.find((s: any) => s.sourceId === input.goalId);
  assert.deepEqual(schedule.cadence, { kind: 'every', everyMs: 900000 });
  assert.equal(schedule.nudgeEvery, 2);
  evidence.beforeReopen = await rpc('goal.session.get', input);
  ws!.close(); await app!.cleanup(); app = undefined;
  await open();
  evidence.reopened = await rpc('goal.session.get', input);
  evidence.reopenedJournal = await rpc('goal.journal.list', input);
  evidence.reopenedAsk = { ask: new NeoAskTodoRepository(app!.db.getDatabase()).getAsk(evidence.ask.ask.id) };
  assert.equal(evidence.reopenedAsk.ask.goalId, input.goalId);
  evidence.foreignKeys = app!.db.getDatabase().prepare('PRAGMA foreign_key_check').all();
  assert.deepEqual(evidence.reopened, evidence.beforeReopen);
  assert.equal(evidence.reopenedJournal.entries.length, 10);
  assert.deepEqual(evidence.foreignKeys, []);
  console.log(`PASS: standalone goal, retained journal, schedule restoration and daemon reopen. ${run}/evidence/neo-standalone-goals.json`);
} finally {
  writeFileSync(join(run, 'evidence/neo-standalone-goals.json'), JSON.stringify(evidence, null, 2));
  ws?.close(); await app?.cleanup();
}
