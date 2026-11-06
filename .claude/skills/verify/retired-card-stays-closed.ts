process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
const expectBug = process.argv.includes('--expect-bug');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableGoalProcessing: true,
  },
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
await app.spaceRuntimeService.ready();
await app.jobProcessor.stop();
await waitForSdkBodyCopy(app.db.getDatabase());
const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, {
  headers: { authorization: `Bearer ${await readLocalCredential()}` },
} as unknown as string[]);
await new Promise<void>((done, fail) => {
  ws.onopen = () => done();
  ws.onerror = () => fail(new Error('RPC unavailable'));
});
type Reply = Record<string, unknown>;
const rpc = (name: string, input: unknown) =>
  new Promise<Reply>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 15000);
    ws.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      done(reply.error ? { error: reply.error } : (reply.data?.value ?? reply.data));
    };
    ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
const root = 'neo:00000000-0000-4000-8000-000000009890';
const seed = (id: string) =>
  app.db.createSession({ id, title: 'Synthetic retired card', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const minutes = (n: number) => { shift += n * 60_000; };
const cards = (askId: string) =>
  service.todos.listQuestions(askId).map((q) => ({ id: q.id.slice(0, 8), state: q.state, text: q.text.slice(0, 60) }));
const open = (askId: string) => service.todos.listQuestions(askId).filter((q) => q.state === 'open');
const report: { passed?: boolean; error?: string; cases: Reply[] } = { cases: [] };

async function blocked(kind: string) {
  const worker = `synthetic-${kind}`, id = `todo-${kind}`, at = Date.now();
  await seed(worker);
  const ask = service.todos.openAsk({ id: kind, sessionId: root, projectId: null, originMessageId: null, title: kind, request: 'Replay a retired card', createdAt: at });
  const todo = service.todos.addTodo(id, ask.id, { title: kind, doneWhen: 'Synthetic evidence exists', check: { pack: 'core', kind: 'evidence', params: { path: join(run, `missing-${kind}`) } }, instruction: 'Synthetic assigned work', named: null }, at);
  const ref = { adapter: 'hyperneo', id: worker };
  service.todoSessions.create(id, { verb: 'send', ref });
  service.todoSessions.recordRef(id, ref, at);
  service.todoSessions.recordSent(id, { inputBefore: at, opening: 'Synthetic assigned work', receipt: { executionId: worker, inputId: `${worker}-input` } });
  service.todos.updateTodo(todo, { state: 'doing', startedAt: at }, at);
  const dispatch = await service.todoSessions.inputs.accept(id, root, { verb: 'send', ref }, 'Synthetic assigned work', at);
  await service.todoSessions.inputs.recordOutcome(dispatch, { ref, receipt: { executionId: worker, inputId: `${worker}-input` } }, at);
  await app.db.saveUserMessage(worker, { type: 'user', uuid: `${worker}-input`, session_id: worker, parent_tool_use_id: null, message: { role: 'user', content: 'Synthetic assigned work' } } as SDKMessage, 'consumed');
  await new Promise((done) => setTimeout(done, 5));
  await app.db.saveSDKMessage(worker, { type: 'result', subtype: 'success', uuid: crypto.randomUUID(), parent_tool_use_id: null, is_error: false, result: 'Work paused.\nBlocked (needs_human): Awaiting synthetic approval', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] } as SDKMessage);
  await rpc('work.status', { ref, since: at });
  await service.refreshDriverWork();
  assert.equal(service.todos.getTodo(id)?.blockedBy, 'needs-human');
}
async function cardFor(kind: string) {
  const id = `todo-${kind}`;
  let source = 'daemon fallback';
  if (!open(kind).length) {
    source = 'Neo';
    const asked = await rpc('neo.question.ask', { askId: kind, todoId: id, kind: 'yesno', text: 'Approve the synthetic step?', yesLabel: 'Approve', noLabel: 'Stop' });
    assert.equal(asked.ok, true, JSON.stringify(asked));
  }
  assert.equal(open(kind).length, 1);
  return { id, card: open(kind)[0]!, source };
}
async function sweeps(kind: string) {
  const seen = [];
  for (const step of [1, 2, 61, 61]) {
    minutes(step);
    await service.refreshDriverWork();
    seen.push({ afterMinutes: step, open: open(kind).length });
  }
  return seen;
}
const retire = (questionId: string) =>
  rpc('neo.question.retire', { questionId, reason: 'The linked work already finished.' });
const brief = (reply: Reply) => ({ ok: reply.ok, reason: typeof reply.reason === 'string' ? reply.reason.slice(0, 80) : undefined, error: reply.error });

try {
  await seed(root);
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });

  for (const kind of ['retire', 'continue', 'replace', 'finished']) await blocked(kind);
  minutes(61);
  await service.refreshDriverWork();
  const plain = await cardFor('retire');
  const retired = await retire(plain.card.id);
  const swept = await sweeps('retire');
  report.cases.push({ case: 'Neo closes the card, todo still blocked', cardFrom: plain.source, retire: brief(retired), sweeps: swept, todo: service.todos.getTodo(plain.id)?.blockedBy, cards: cards('retire') });
  if (expectBug) {
    assert.equal(retired.ok, true);
    assert(swept.some((s) => s.open > 0), 'expected the old bug to reopen a card');
  } else {
    assert.equal(retired.ok, false);
    assert.match(String(retired.reason), /^todo_waiting/);
    assert.deepEqual(swept.map((s) => s.open), [1, 1, 1, 1]);
    assert.equal(open('retire')[0]?.id, plain.card.id);
    assert.equal(service.todos.listQuestions('retire').length, 1);

    const removed = await rpc('neo.todo.remove', { todoId: plain.id, reason: 'The linked work already finished.' });
    const afterRemove = open('retire').length;
    const closed = afterRemove ? await retire(plain.card.id) : null;
    const settled = await sweeps('retire');
    report.cases.push({ case: 'Neo removes the todo, then closes the card', remove: brief(removed), openAfterRemove: afterRemove, retire: closed && brief(closed), sweeps: settled, todo: service.todos.getTodo(plain.id)?.state ?? 'gone', cards: cards('retire') });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.deepEqual(settled.map((s) => s.open), [0, 0, 0, 0]);

    const going = await cardFor('continue');
    const continued = await rpc('neo.todo.continue', { todoId: going.id, message: 'Carry on without approval.' });
    const rightAfter = { state: service.todos.getTodo(going.id)?.state, blockedBy: service.todos.getTodo(going.id)?.blockedBy };
    const afterContinue = open('continue').length;
    const closedToo = afterContinue ? await retire(going.card.id) : null;
    const kept = await sweeps('continue');
    report.cases.push({ case: 'Neo sends the worker on, then closes the card', continue: brief(continued), rightAfter, openAfterContinue: afterContinue, retire: closedToo && brief(closedToo), sweeps: kept, todo: { state: service.todos.getTodo(going.id)?.state, blockedBy: service.todos.getTodo(going.id)?.blockedBy }, cards: cards('continue') });
    assert.equal(continued.ok, true, JSON.stringify(continued));
    assert.equal(open('continue').filter((q) => q.text.includes('Awaiting synthetic approval')).length, 0);
    assert.equal(rightAfter.state, 'doing');

    const swapped = await cardFor('replace');
    const asked = await rpc('neo.question.ask', { askId: 'replace', todoId: swapped.id, kind: 'yesno', text: 'Better worded question?', yesLabel: 'Approve', noLabel: 'Stop', replaces: swapped.card.id });
    const one = await sweeps('replace');
    report.cases.push({ case: 'Neo replaces the card', ask: brief(asked), sweeps: one, cards: cards('replace') });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    assert.deepEqual(one.map((s) => s.open), [1, 1, 1, 1]);

    const done = await cardFor('finished');
    writeFileSync(join(run, 'missing-finished'), 'Synthetic evidence.');
    await service.sweepPacks();
    const finished = await sweeps('finished');
    report.cases.push({ case: 'The work finished: the check passes on the next sweep', sweeps: finished, todo: { state: service.todos.getTodo(done.id)?.state, blockedBy: service.todos.getTodo(done.id)?.blockedBy }, cards: cards('finished') });
    assert.deepEqual(finished.map((s) => s.open), [0, 0, 0, 0]);
  }
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  Date.now = realNow;
  ws.close();
  await service.dispose();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/retired-card.json'), JSON.stringify(report, null, 2));
}
