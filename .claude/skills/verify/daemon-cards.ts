process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { NEO_HUMAN_STEP, neoDaemonCardDraft } from '../../../packages/daemon/src/lib/neo/daemon-cards.ts';
import { openHumanCard } from '../../../packages/daemon/src/lib/neo/human-card.ts';
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
const root = 'neo:00000000-0000-4000-8000-000000009504';
const evidence: Record<string, unknown> = { steps: [] };
const step = (name: string, data: unknown) => { (evidence.steps as unknown[]).push({ name, clock: clock - start, data }); console.log(name); };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
const open = async () => {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableGoalProcessing: true }, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
};
const close = async () => { await service?.dispose(); service = undefined; await app?.cleanup(); app = undefined; };
const registry = () => app!.sessionManager.getOperationRegistry();
const neo = async (name: string, input: unknown) => {
  const reply = await createOperationMcpHandler(registry, () => ({ sessionId: root, role: 'neo' }))({ name, input });
  return JSON.parse(reply.content[0].text);
};
const human = async (questionId: string, answer: string) => {
  const outcome = await invokeOperation(registry(), 'neo.question.answer', { questionId, answer: [answer] }, { source: 'rpc', principal: 'local' });
  step(`the human answers ${answer}`, outcome);
  assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
};
const cards = (cause: string) => app!.db.getDatabase().prepare('SELECT id, state, todos, options, text, document FROM neo_questions WHERE cause = ? ORDER BY created_at').all(cause) as { id: string; state: string; todos: string; options: string; text: string; document: string | null }[];
const openCards = (cause: string) => cards(cause).filter((card) => card.state === 'open');
const state = (id: string) => service!.todos.getTodo(id)?.state;
const refresh = () => service!.refreshDriverWork();
const settle = async (id: string, expected: string) => {
  for (let tries = 0; tries < 20 && state(id) !== expected; tries++) { await refresh(); await new Promise((done) => setTimeout(done, 50)); }
  assert.equal(state(id), expected, `${id} becomes ${expected}`);
};
try {
  await open();
  await app!.db.createSession({ id: root, title: 'Synthetic daemon card owner', workspacePath: join(run, 'workspace'), createdAt: new Date(start).toISOString(), lastActiveAt: new Date(start).toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app!.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });

  const allCards = () => app!.db.getDatabase().prepare('SELECT cause, state FROM neo_questions').all() as { cause: string; state: string }[];
  const wakes = (id: string) => (app!.db.getDatabase().prepare("SELECT json_extract(payload, '$.message.message.content') AS text FROM job_queue WHERE queue = 'mailbox' ORDER BY created_at, rowid").all() as { text: string }[]).map((row) => String(row.text)).filter((text) => text.includes(`(${id}) needs your next step`));
  const sweep = async () => { await service!.sweepPacks(); await service!.sweepPacks(); };

  service!.todos.openAsk({ id: 'checks', sessionId: root, projectId: null, originMessageId: null, title: 'Synthetic check-only work', request: 'Wait for evidence', createdAt: start });
  const evidenceCheck = { pack: 'core', kind: 'evidence', params: { path: join(run, 'never-written') } };
  service!.todos.addTodo('first-todo', 'checks', { title: 'Form signed', doneWhen: 'Form signed', check: evidenceCheck, instruction: null, named: null, dependsOn: [], approvedAt: start }, start);
  clock += 1;
  await Promise.all([refresh(), refresh()]);
  await sweep();
  assert.deepEqual(allCards(), []);
  assert.deepEqual(wakes('first-todo'), []);
  step('check-only step: no card and no wake while the daemon polls its check', allCards());

  service!.todos.addTodo('legacy-todo', 'checks', { title: 'Old card step', doneWhen: 'Done', check: evidenceCheck, instruction: null, named: null, dependsOn: [] }, start);
  const legacy = openHumanCard(service!.todos, 'legacy-card', 'checks', { ...neoDaemonCardDraft(NEO_HUMAN_STEP, [service!.todos.getTodo('legacy-todo')!]), todoId: 'legacy-todo' }, clock);
  await human(legacy.id, 'Mark done');
  await close(); await open();
  await settle('legacy-todo', 'done');
  step('daemon card open from before: its answer is still carried out after a restart', { card: service!.todos.getQuestion(legacy.id), todo: service!.todos.getTodo('legacy-todo') });

  const ask = await neo('neo.ask.open', { title: 'Synthetic failing start', request: 'Start on a missing daemon' });
  assert.equal(ask.ok, true, JSON.stringify(ask));
  const added = await neo('neo.todo.add', { askId: ask.ask.id, title: 'Remote step', after: [], instruction: 'Synthetic instruction', check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'never-written') } }, target: { verb: 'start', adapter: 'hyperneo', place: { daemon: 'synthetic-missing-daemon', machine: 'synthetic-machine', name: 'synthetic', folder: join(run, 'workspace') } } });
  step('failed start: add', added);
  assert.equal(added.ok, true, JSON.stringify(added));
  const failing = added.todo.id as string;
  await refresh();
  const retries = (app!.db.getDatabase().prepare('SELECT retries FROM neo_todo_sessions WHERE todo_id = ?').get(failing) as { retries: number }).retries;
  assert.equal(retries, 2);
  assert.deepEqual(allCards().filter((card) => card.cause !== 'human_step'), []);
  assert.equal(service!.todos.getTodo(failing)?.blockedBy, 'failure');
  await sweep();
  const failed = wakes(failing);
  step('failed start: two automatic retries, no card, then one wake to Neo', { retries, todo: service!.todos.getTodo(failing), wakes: failed });
  assert.equal(failed.length, 1);
  assert.match(failed[0]!, /: it failed: invalid_place: .+ Continue it with new direction, start a fresh worker, or remove it\.$/);
  const removed = await neo('neo.todo.remove', { todoId: failing, reason: 'Synthetic: the daemon is gone.' });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  step('failed start: Neo removes it', service!.todos.getTodo(failing));

  const sessions = new NeoTodoSessionRepository(app!.db.getDatabase());
  const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
  service!.todos.openAsk({ id: 'blocked', sessionId: root, projectId: null, originMessageId: null, title: 'Synthetic blocker', request: 'Ask the human', createdAt: clock });
  service!.todos.addTodo('blocker-todo', 'blocked', { title: 'Deploy', doneWhen: 'Deployed', check: null, instruction: 'Deploy it', named: null, approvedAt: clock }, clock);
  sessions.create('blocker-todo', { verb: 'send', ref });
  sessions.recordRef('blocker-todo', ref, clock);
  sessions.recordLive('blocker-todo', 'stopped', undefined);
  await sessions.inputs.accept('blocker-todo', 'neo', { verb: 'send', ref }, 'Deploy it', clock);
  const dispatch = sessions.inputs.list('blocker-todo').at(-1)!.id;
  const blocked = service!.todos.updateTodo(service!.todos.getTodo('blocker-todo')!, { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Needs the staging password', nextAction: 'Neo must answer the worker or ask the human with options.', report: 'Blocked (needs_human): Needs the staging password', startedAt: clock }, clock);
  sessions.recordNudge('blocker-todo', { since: clock, nudges: 0, blockerReport: { id: 'synthetic', dispatchId: dispatch, at: clock, triagedAt: blocked.updatedAt } });
  clock += 2 * hour;
  await Promise.all([refresh(), refresh()]);
  await sweep();
  assert.deepEqual(allCards().filter((card) => card.cause === 'worker_blocker'), []);
  const asked = wakes('blocker-todo');
  step('ignored blocker: no card after two hours; the step wakes Neo', asked);
  assert(asked.length >= 1);
  assert(asked.every((text) => text.endsWith('it waits on an answer and no card is open. Answer its worker, or ask the human with neo.question.ask.')));
  evidence.passed = true;
  console.log('PASS: on the real daemon a ready check-only step, a twice-failed start and an ignored blocker open no card and reach Neo instead; a daemon card open from before still has its answer carried out.');
} catch (error) { evidence.error = String(error); throw error; }
finally { await close(); Date.now = realNow; evidence.resourcesClosed = true; writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2)); }
