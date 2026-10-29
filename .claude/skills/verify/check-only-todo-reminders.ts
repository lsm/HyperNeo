import assert from 'node:assert/strict';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const hour = 3_600_000, start = Date.now(), realNow = Date.now;
let clock = start;
Date.now = () => clock;
const root = 'neo:00000000-0000-4000-8000-000000009503';
const evidence: Record<string, unknown> = { checks: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
let socket: WebSocket | undefined;
const open = async () => {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableGoalProcessing: true }, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('RPC connection failed')); });
};
const close = async () => { socket?.close(); socket = undefined; await service?.dispose(); service = undefined; await app?.cleanup(); app = undefined; };
const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 10000);
  socket!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
  socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
const notes = () => (app!.db.getDatabase().prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY rowid").all() as { payload: string }[]).map(row => JSON.parse(row.payload)).filter(entry => entry.message.message.content.includes('(queued-todo)'));
const check = (name: string, count: number) => {
  const rows = notes();
  (evidence.checks as unknown[]).push({ name, clock, rows });
  assert.equal(rows.length, count, name);
};
const refresh = () => service!.refreshDriverWork();
const receipt = async (index: number, status: 'consumed' | 'failed') => {
  const entry = notes()[index];
  const dbId = await app!.db.saveUserMessage(root, { ...entry.message, uuid: entry.messageUuid, session_id: root, message: { role: 'user', content: entry.message.message.content } }, status);
  await app!.db.getSDKMessageRepo().write('updateMessageTimestamp', dbId, clock);
  const visible = await rpc('operation.invoke', { name: 'message.status', input: { sessionId: root, messageId: entry.messageUuid } });
  (evidence.checks as unknown[]).push({ name: `public ${status} receipt`, visible });
  assert(JSON.stringify(visible).includes(status === 'consumed' ? 'delivered' : 'failed'));
  await refresh();
};
try {
  await open();
  await app!.db.createSession({ id: root, title: 'Synthetic daily reminder recipient', workspacePath: join(run, 'workspace'), createdAt: new Date(start).toISOString(), lastActiveAt: new Date(start).toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app!.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  service!.todos.openAsk({ id: 'queued', sessionId: root, projectId: null, originMessageId: null, title: 'Synthetic check-only work', request: 'Keep it visible', createdAt: start });
  const path=join(run,'completion-evidence');
  service!.todos.addTodo('queued-todo','queued',{title:'Check-only todo',doneWhen:'Evidence exists',check:{pack:'core',kind:'evidence',params:{path}},instruction:null,named:null},start);
  clock += 24 * hour - 1;
  await refresh(); check('before 24 hours',0);
  clock++;
  await Promise.all([refresh(),refresh()]); check('24-hour reminder to Neo',1);
  assert.equal(notes()[0].to.sessionId,root);
  assert.equal(notes()[0].deliveryMode,'defer');
  assert.match(notes()[0].message.message.content,/instruction.*target.*hold.*remove/i);
  clock += 24 * hour;
  await refresh(); check('pending admission does not duplicate',1);
  await receipt(0,'failed'); check('failed delivery does not spend the day',2);
  await receipt(1,'consumed');
  await close(); await open();
  clock += 24 * hour - 1;
  await refresh(); check('restart keeps the daily cooldown',2);
  clock++;
  await refresh(); check('one day after delivery',3);
  await receipt(2,'consumed');
  for(let day=0;day<3;day++){
    clock+=24*hour;await refresh();check('daily reminders continue until action',4+day);await receipt(3+day,'consumed');
  }
  evidence.beforeCompletion=await rpc('operation.invoke',{name:'neo.snapshot',input:{}});
  assert.equal(service!.todos.getTodo('queued-todo')?.state,'todo');
  writeFileSync(path,'Synthetic passing evidence');
  await refresh(); assert.equal(service!.todos.getTodo('queued-todo')?.state,'done');
  clock+=48*hour;await refresh();check('passing check stops reminders',6);
  evidence.snapshot=await rpc('operation.invoke',{name:'neo.snapshot',input:{}});
  assert(JSON.stringify(evidence.snapshot).includes('Check-only todo'));
  evidence.passed=true;
} catch(error){evidence.error=String(error);throw error;}
finally{await close();Date.now=realNow;evidence.resourcesClosed=true;writeFileSync(join(run,'evidence/result.json'),JSON.stringify(evidence,null,2));}
