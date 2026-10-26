import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import type { DbOp } from '../../../packages/daemon/src/storage/db-gateway/db-op.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const path of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, path), {recursive: true});
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', {mode: 0o700});
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
const app = await createDaemonApp({config: getConfig({port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db')}), verbose: false});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({defaultSessionId: 'global'});
const transport = new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`});
hub.registerTransport(transport);
const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db), prepare = db.prepare.bind(db);
let recording = false, mainSql = 0, announcements = 0;
db.prepare = ((sql: string) => { if (recording && /neo_todos|neo_asks|neo_questions|pack_coding_pr_claims/.test(sql)) mainSql++; return prepare(sql); }) as typeof db.prepare;
const off = hub.onEvent('neo.changed', () => { announcements++; });
type Outcome = {ok: false; reason: string} | {ok: true; todo: NeoTodo; patch?: Partial<NeoTodo>; records?: string[]};
const read: DbOp<{method: string; args: unknown[]}, Outcome> = {
  name: 'neo.todoMutationReads', mode: 'read',
  run: () => { throw new Error('The planner must run in the real reader worker'); },
};
const plan = (input: unknown) => app.db.gateway.run(read, {method:'plan',args:[input,10,[]]});
const visible = () => hub.request<{ok: true; entry: {todos: NeoTodo[]}}>('operation.invoke',{name:'neo.ask.read',input:{askId:'ask'}});
const report: Record<string, unknown> = {mode, plannerRegistered: false, mutationRpcActivated: false};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  const root = 'neo:10000000-0000-4000-8000-000000009015';
  await app.db.createSession({id:root,title:'Synthetic mutation planning',workspacePath:join(run,'workspace'),createdAt:new Date().toISOString(),lastActiveAt:new Date().toISOString(),status:'active',config:{queryMode:'manual'},metadata:{messageCount:0,totalTokens:0,inputTokens:0,outputTokens:0,totalCost:0,toolCallCount:0}});
  new NeoRepository(db).reserveBinding({sessionId:root,kind:'neo',projectId:null});
  store.openAsk({id:'ask',projectId:null,sessionId:root,originMessageId:null,title:'Planning only',request:'Preserve the card',createdAt:1});
  const check = {pack:'coding',kind:'pr_merged',params:{urls:[]}};
  const first = store.addTodo('first','ask',{title:'Original title',doneWhen:'Merged',check,instruction:'Continue',named:null},1);
  const text = 'Complete stored report 🦊\n'.repeat(20000).trim();
  store.updateTodo(first,{report:text},2);
  store.addTodo('peer','ask',{title:'Peer',doneWhen:'Merged',check:{...check,params:{urls:['https://github.com/synthetic/planning/pull/1']}},instruction:null,named:null},1);
  store.askQuestion('card','ask',{text:'Start?',kind:'start',options:null,multiple:false,yesLabel:null,noLabel:null,startTodos:['first']},3);
  store.askQuestion('reply','ask',{kind:'reply',todoId:'first',text:'Answer before completion',options:null,multiple:false,yesLabel:null,noLabel:null},3);
  const before = await visible();
  assert.equal(before.entry.todos[0].report,text);
  await hub.request('system.health',{});
  const priorEvents = announcements;
  recording = true;
  if (mode === 'before') {
    await assert.rejects(plan({kind:'edit',todoId:'first',title:'Proposed'}), /unknown.*neo.todoMutationReads/i);
    report.missingPlannerReproduced = true;
  } else {
    const planned = await plan({kind:'edit',todoId:'first',title:'Proposed',addUrls:['https://github.com/synthetic/planning/pull/1']});
    assert(planned.ok && planned.patch);
    assert.equal(planned.patch.title,'Proposed');
    assert(planned.records?.some(record => record.startsWith('pr_already_tracked:')));
    assert.equal(planned.todo.report,text);
    const proposed = await plan({kind:'edit',todoId:'first',check:{pack:'core',kind:'evidence',params:{path:join(run,'not-created')}}});
    assert(proposed.ok && proposed.patch);
    assert.equal(proposed.patch.doneWhen,`File ${join(run,'not-created')} exists.`);
    assert.equal((await plan({kind:'remove',todoId:'first',reason:'Only a plan'})).ok,true);
    const completion = await plan({kind:'edit',todoId:'first',done:'reported',evidence:'Only a proposal'});
    assert(!completion.ok && completion.reason.startsWith('card_unanswered:'), 'planning must refuse completion while a todo card is unanswered');
    report.unansweredCompletionRefused = true;
    report.plannerRegistered = true;
    report.records = planned.records;
    report.derivedCheck = proposed.patch.check;
  }
  recording = false;
  assert.deepEqual(await visible(),before);
  assert.equal(store.getQuestion('card')!.state,'open');
  await hub.request('system.health',{});
  assert.equal(announcements,priorEvents);
  assert.equal(mainSql,0);
  report.fullReport = {bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};
  report.visibleTitle = before.entry.todos[0].title;
  report.cardState = 'open';
  report.noAnnouncements = true;
  report.mainSql = mainSql;
  report.verified = true;
} finally {
  off(); db.prepare = prepare;
  await transport.close(); await app.cleanup(); globalThis.fetch = network;
  report.resourcesStopped = true;
  writeFileSync(join(run,'evidence/todo-mutation-planning.json'),JSON.stringify(report,null,2).replaceAll(run,'<synthetic-run>'));
}
console.log(JSON.stringify(report).replaceAll(run,'<synthetic-run>'));
