import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { readCodexTurn, type CodexThreadDetail } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import type { SessionManager } from '../../../packages/daemon/src/lib/session/session-manager.ts';

const run = resolve(process.argv[2] ?? '');
assert(process.argv[2] && process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${run}/bin:${process.env.PATH}`;
const coordinatorBodies: { messages: { role: string; content: unknown }[] }[] = [];
let workerStatus = 'running';
let waitingFor: string | undefined;
let modelTurns = 0;
let modelRequests = 0;
const model = Bun.serve({ hostname: '127.0.0.1', port: 8000, async fetch(req) {
  if (new URL(req.url).pathname !== '/v1/messages') return Response.json({ data: [], has_more: false });
  const body = await req.json();
  writeFileSync(join(run, `evidence/model-${++modelRequests}.json`), JSON.stringify(body, null, 2));
  if (body.tools?.some((tool: { name: string }) => tool.name === 'mcp__hyperneo-operations__invoke')) { modelTurns++; coordinatorBodies.push(body); }
  const start = { id: `msg_${modelTurns}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  const events = [
    ['message_start', { type: 'message_start', message: start }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic human reply.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
const build = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await build.apply(this, args);
  return { ...options, sandbox: { enabled: false } };
};
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
let service: ReturnType<typeof createNeoService> | undefined;
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  const { servers } = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const opened = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', { name: 'neo.open', input: {} });
  assert(opened.ok);
  const root = opened.sessionId;
  let turnEnds: Awaited<ReturnType<typeof readCodexTurn>>['turnEnds'] = [];
  const status = app.sessionManager.getOperationRegistry().get('work.status');
  assert(status);
  const registry = createOperationRegistry([{ ...status, execute: async () => ({ ok: true, value: {
    ref: { adapter: 'codex-desktop', id: 'synthetic-worker' }, title: 'Synthetic worker',
    place: { machine: 'local', name: 'Synthetic' }, status: workerStatus,
    lastActivityAt: Date.now(), turnEnds, ...(waitingFor !== undefined ? { waitingFor } : {}),
  } }) }]);
  service = createNeoService(app.db, { getOperationRegistry: () => registry } as unknown as SessionManager, app.messageHub, app.internalEventBus);
  const readOnlyQuiet = [];
  const bodyCopyReady = () => app.db.getDatabase().prepare(
    "SELECT 1 FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'"
  ).get();
  const bodyCopyDeadline = Date.now() + 15000;
  while (!bodyCopyReady() && Date.now() < bodyCopyDeadline) await Bun.sleep(25);
  assert(bodyCopyReady(), 'startup body copy must finish before the read-only proof');
  app.db.getDatabase().exec('PRAGMA query_only=ON');
  try {
    for (const kind of ['focused_status', 'quiet_heartbeat'] as const) {
      const id = `synthetic-readonly-${kind}`;
      await Promise.all(Array.from({ length: 10 }, () => service!.deliverForward(root, id, 'Quiet persisted report.', root, kind)));
      const count = (app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND sdk_uuid=?').get(root, id) as { n: number }).n;
      assert.equal(count, 1);
      readOnlyQuiet.push({ kind, historyRows: count, neoTurns: modelTurns });
    }
  } finally {
    app.db.getDatabase().exec('PRAGMA query_only=OFF');
    writeFileSync(join(run, 'evidence/readonly-quiet.json'), JSON.stringify(readOnlyQuiet, null, 2));
  }
  const requestId = crypto.randomUUID();
  const receipt = await hub.request<{ ok: boolean }>('operation.invoke', { name: 'neo.message.send', input: { sessionId: root, requestId, content: 'Hello from the synthetic human.' } });
  assert(receipt.ok);
  const deadline = Date.now() + 45000;
  const results = () => app.db.getDatabase().prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='result'").get(root) as { n: number };
  while (results().n < 2 && Date.now() < deadline) await Bun.sleep(100);
  assert.equal(results().n, 2);
  assert.equal(modelTurns, 2);
  const ref = { adapter: 'codex-desktop', id: 'synthetic-worker' };
  const now = Date.now();
  const ask = service.todos.openAsk({ id: 'synthetic-ask', projectId: null, sessionId: root, originMessageId: 'synthetic-origin', title: 'Discussion', request: 'Discuss', createdAt: now });
  const todo = service.todos.addTodo('synthetic-todo', ask.id, { title: 'Discuss', doneWhen: 'Human decides', instruction: null, named: null, check: null }, now);
  service.todos.updateTodo(todo, { state: 'doing', startedAt: now }, now);
  service.todoSessions.bind(todo.id, ref, now);
  const dispatch = await service.todoSessions.inputs.accept(todo.id, root, { verb: 'send', ref }, 'Discuss', now - 60_000);
  await service.todoSessions.inputs.recordOutcome(dispatch, { ref }, now);
  const rolloutPath = join(run, 'rollout.jsonl');
  const heartbeat = '<heartbeat>\n<automation_id>reviewbot-test</automation_id>\n<decision>DONT_NOTIFY</decision>\n<message>TEST remains healthy</message>\n</heartbeat>';
  writeFileSync(rolloutPath, JSON.stringify({ type: 'event_msg', timestamp: new Date(now + 1).toISOString(), payload: { type: 'task_complete', turn_id: 'heartbeat', last_agent_message: heartbeat } }));
  turnEnds = (await readCodexTurn({ thread: { rolloutPath }, roots: [] } as unknown as CodexThreadDetail)).turnEnds;
  assert.equal(turnEnds?.[0].notify, false);
  const observed: Record<string, unknown> = { daemonPort: app.server.port, readOnlyQuiet, humanBaselineTurns: modelTurns, sandboxEnforcementVerified: false };
  const latestInput = () => {
    const content = coordinatorBodies.at(-1)?.messages.filter((message) => message.role === 'user').at(-1)?.content;
    return typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n') : '';
  };
  const refresh = () => service!.todoRunner.refresh((message, error) => { throw new Error(message, { cause: error }); });
  const expectTurns = async (label: string, expected: number) => {
    await refresh();
    const deadline = Date.now() + 8000;
    while (results().n < expected && Date.now() < deadline) await Bun.sleep(50);
    await Bun.sleep(200);
    observed[label] = { modelTurns, results: results().n, expected };
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
    assert.equal(modelTurns, expected, label);
    assert.equal(results().n, expected, label);
  };
  const firstNewTurn = turnEnds;
  turnEnds = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, at: now - 50_000 + i, message: `Previously handled ${i}` }));
  await expectTurns('upgradeHistoryDoesNotReplay', 2);
  workerStatus = 'done';
  await expectTurns('oldHistoryStatusChangeDoesNotReplay', 2);
  workerStatus = 'running';
  turnEnds = firstNewTurn;
  await expectTurns('firstNotifyFalseReport', 3);
  assert(latestInput().includes(heartbeat), 'the unchanged heartbeat must reach Neo inline');
  service.todos.focusAsk(ask.id, { ...ref, name: 'Discussion', label: 'Discussion', provider: 'Codex', link: 'codex://threads/synthetic-worker' }, Date.now());
  turnEnds = [{ id: 'focused', at: now + 2, message: 'Prepared discussion.' }];
  await expectTurns('firstFocusedReport', 4);
  assert(latestInput().includes('Do not act, reply, forward or treat this as approval.'));
  turnEnds = [{ id: 'different-transport-id', at: now + 3, message: 'Prepared discussion.' }];
  await refresh();
  await Bun.sleep(1500);
  assert.equal(modelTurns, 4, 'an exact repeat with a different transport ID must not wake Neo');
  service.dispose();
  service = createNeoService(app.db, { getOperationRegistry: () => registry } as unknown as SessionManager, app.messageHub, app.internalEventBus);
  await refresh();
  await Bun.sleep(1500);
  assert.equal(modelTurns, 4, 'recreating the service must not redeliver the consumed report');
  observed.exactRepeatSurvivesServiceRestart = true;
  turnEnds = [{ id: 'focused', at: now + 4, message: 'Prepared discussion. New reason.' }];
  await expectTurns('changedReasonSameTransportId', 5);
  assert(latestInput().includes('Prepared discussion. New reason.'));
  workerStatus = 'queued';
  await expectTurns('changedWorkerStatusDoesNotReplay', 5);
  waitingFor = 'A different owner decision.';
  await expectTurns('changedStructuredReasonDoesNotReplay', 5);
  turnEnds = [{ id: 'new-turn-after-cutoff', at: Date.now() + 1, message: 'New report after the cutoff.' }];
  await expectTurns('newTurnAfterCutoff', 6);
  assert(latestInput().includes('Waiting for: A different owner decision.'));
  const second = service.todos.addTodo('other-todo', ask.id, { title: 'Other', doneWhen: 'Human decides', instruction: null, named: null, check: null }, now);
  service.todos.updateTodo(second, { state: 'doing', startedAt: now }, now);
  service.todoSessions.bind(second.id, ref, now);
  const secondDispatch = await service.todoSessions.inputs.accept(second.id, root, { verb: 'send', ref }, 'Other', now);
  await service.todoSessions.inputs.recordOutcome(secondDispatch, { ref }, now);
  await expectTurns('sameReportDifferentTodo', 7);
  await app.jobProcessor.stop();
  const historyCount = (id: string) => (app.db.getDatabase().prepare(
    'SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND sdk_uuid=?'
  ).get(root, id) as { n: number }).n;
  const overlaps = [];
  for (const phase of ['pending', 'queued']) {
    const id = `synthetic-urgent-${phase}`;
    const urgent = service.deliverForward(root, id, `Worker failed (${phase}).`, root, 'event');
    if (phase === 'queued') await urgent;
    await service.deliverForward(root, id, 'Status-only retry.', root, 'focused_status');
    await urgent;
    const before = { phase, historyRows: historyCount(id), jobs: app.jobQueue.listActiveByPayload('mailbox', { 'to.sessionId': root, messageUuid: id }).length };
    overlaps.push(before);
    writeFileSync(join(run, 'evidence/overlaps.json'), JSON.stringify(overlaps, null, 2));
    assert.equal(before.historyRows, 0, 'quiet retry saved while urgent delivery was active');
    assert.equal(before.jobs, 1);
  }
  app.jobProcessor.start();
  const overlapDeadline = Date.now() + 45000;
  while (results().n < 9 && Date.now() < overlapDeadline) await Bun.sleep(100);
  assert.equal(results().n, 9);
  assert.equal(modelTurns, 9);
  for (const phase of ['pending', 'queued']) assert.equal(historyCount(`synthetic-urgent-${phase}`), 1);
  Object.assign(observed, { readOnlyQuiet, urgentOverlaps: overlaps, urgentTurns: modelTurns - 7, urgentHistoryRows: 2, finalTurns: modelTurns, finalResults: results().n });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed));
} finally {
  service?.dispose();
  await transport.close();
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
}
