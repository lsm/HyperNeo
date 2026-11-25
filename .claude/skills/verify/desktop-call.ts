import assert from 'node:assert/strict';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import catalog from '../../../packages/daemon/src/lib/desktop/tool-catalog.json' with { type: 'json' };
import { DesktopTurn } from '../../../packages/daemon/src/lib/desktop/host-dispatch.ts';
import { operationInvoke } from '../../../packages/daemon/tests/helpers/operation-mcp.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { planSessionDoorCall } from '../../../packages/daemon/src/lib/messaging/session-door.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) assert(!process.env[name]);
mkdirSync(join(run, 'data/desktop'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
assert(![8399, 8499].includes(app.server.port));
const requests: Record<string, unknown>[] = [];
const cancelTurn = Promise.withResolvers<() => void>();
const pendingDispatch = Promise.withResolvers<() => void>();
let holdDispatch = false;
let legacyHost = false;
let hostBusy = false;
let hostTimeout = false;
let hostLocked = false;
const driverError = {
  content: [{ type: 'text', text: 'No screenshot of window 7: call get_window_state first' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
  structuredContent: { code: 'no_screenshot' },
};
const host = createServer(socket => {
  let line = '';
  socket.on('data', chunk => {
    line += chunk;
    if (!line.includes('\n')) return;
    const request = JSON.parse(line);
    requests.push(request);
    if (request.action === 'cancelTurn') {
      if (legacyHost) {
        socket.end(JSON.stringify({ ok: false, error: 'unknown field `callIds`, expected a dispatch field' }) + '\n');
        return;
      }
      cancelTurn.resolve(() => socket.end('{"ok":true,"result":{"state":"stopped"}}\n'));
      return;
    }
    assert.deepEqual(Object.keys(request).sort(), ['action', 'apps', 'arguments', 'callId', 'todo', 'todos', 'tool', 'workDir', 'worker']);
    if (holdDispatch) {
      pendingDispatch.resolve(() => socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: null, class: null, decision: 'refused', reason: 'turn_stopped', dispatched: false } }) + '\n'));
      return;
    }
    if (hostBusy) {
      socket.end(JSON.stringify({ ok: false, error: 'desktop_busy' }) + '\n');
      return;
    }
    if (hostTimeout || hostLocked) {
      const reason = hostLocked ? 'screen_locked' : 'desktop_timeout';
      socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: 'org.example.fixture', class: 'pointer', decision: 'refused', reason, dispatched: false } }) + '\n');
      return;
    }
    const body = request.tool === 'get_window_state' ? { reason: 'driver_error', ...driverError } : { reason: null };
    socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: 'org.example.fixture', class: 'pointer', decision: 'allowed', dispatched: true, ...body } }) + '\n');
  });
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  createSocket: (url) => createLocalSocket(url),
});
hub.registerTransport(transport);
try {
  await app.jobProcessor.stop();
  host.listen(join(run, 'data/desktop/control.sock'));
  await once(host, 'listening');
  const worker = await app.sessionManager.createSession({ workspacePath: run, title: 'Synthetic desktop worker' });
  const agent = app.sessionManager.getSession(worker)!;
  assert(agent);
  const sql = app.db.getDatabase();
  const now = Date.now();
  const fixtureApps = JSON.stringify([{ bundleId: 'org.example.fixture', name: 'Fixture' }]);
  sql.prepare("INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES('ask','neo:fixture','Synthetic action','','open',?,?)").run(now, now);
  sql.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,named,state,approved_at,desktop_apps,created_at,updated_at) VALUES('todo','ask',0,'Synthetic click','Observed',?, 'doing',?,?,?,?)").run(JSON.stringify({ desktopControl: true }), now, fixtureApps, now, now);
  sql.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run('todo', JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: worker }));
  const call = operationInvoke(agent.getOperationMcpServer());
  const described = JSON.stringify(JSON.parse((await call({ name: 'operations.describe', input: { name: 'desktop.call' } })).content[0].text));
  const listedTools = catalog.filter(tool => described.includes(`"const":"${tool.name}"`));
  assert.equal(listedTools.length, catalog.length, described);
  assert(described.includes('list the windows of every app this todo may use'));
  assert(described.includes('For * and other shifted symbols, send the base key with shift'));
  assert(described.includes('Unknown key names return driver_error'));
  const input = { tool: 'click', args: { pid: 123, x: 5, y: 7 } };
  sql.prepare("UPDATE neo_todos SET desktop_apps=NULL WHERE id='todo'").run();
  const noScope = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(noScope.reason, 'desktop_not_enabled');
  assert.equal(noScope.dispatched, false);
  assert.equal(requests.length, 0);
  sql.prepare("UPDATE neo_todos SET desktop_apps=? WHERE id='todo'").run(fixtureApps);
  const allowed = await call({ name: 'desktop.call', input });
  const reply = JSON.parse(allowed.content[0].text);
  assert.equal(reply.dispatched, true, JSON.stringify(allowed));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, 'dispatch');
  assert.equal(requests[0].worker, worker);
  assert.equal(requests[0].workDir, run);
  assert.deepEqual(requests[0].arguments, input.args);
  assert.deepEqual(requests[0].apps, ['org.example.fixture']);
  const audit = sql.prepare("SELECT session_id, params_summary FROM mcp_audit_log WHERE tool_name='desktop.call'").all() as Array<{ session_id: string; params_summary: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].session_id, worker);
  assert.deepEqual(JSON.parse(audit[0].params_summary), { todo: 'todo', session: worker, tool: 'click', app: 'org.example.fixture', class: 'pointer', decision: 'allowed', reason: null, dispatched: true });
  const failed = await call({ name: 'desktop.call', input: { tool: 'get_window_state', args: { pid: 123, window_id: 7 } } });
  const failure = JSON.parse(failed.content[0].text);
  assert.equal(failure.ok, false, JSON.stringify(failed));
  assert.equal(failed.isError, true);
  assert.notEqual(allowed.isError, true);
  assert.equal(failure.reason, 'driver_error');
  assert.deepEqual(failure.structuredContent, driverError.structuredContent);
  assert.deepEqual(failed.content.slice(1), driverError.content);
  const audited = sql.prepare("SELECT params_summary FROM mcp_audit_log WHERE tool_name='desktop.call' ORDER BY rowid").all() as Array<{ params_summary: string }>;
  assert.equal(audited.length, 2);
  assert.deepEqual(JSON.parse(audited[1].params_summary), { todo: 'todo', session: worker, tool: 'get_window_state', app: 'org.example.fixture', class: 'pointer', decision: 'allowed', reason: 'driver_error', dispatched: true });
  const registry = app.sessionManager.getOperationRegistry();
  const rpc = await invokeOperation(registry, 'desktop.call', input, { source: 'rpc', principal: 'local', sessionId: worker, role: 'direct_task_worker' });
  assert(!('value' in rpc) || !(rpc.value as { dispatched?: boolean }).dispatched);
  const door = planSessionDoorCall({ sender: worker, name: 'desktop.call', input });
  assert('reason' in door);
  await call({ name: 'desktop.call', input: { ...input, worker: 'other-worker' } });
  await call({ name: 'desktop.call', input: { tool: 'kill_app', args: {} } });
  sql.prepare("UPDATE neo_todos SET approved_at=NULL WHERE id='todo'").run();
  await call({ name: 'desktop.call', input });
  assert.equal(requests.length, 2);
  sql.prepare("UPDATE neo_todos SET state='blocked', approved_at=? WHERE id='todo'").run(now);
  const blocked = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(blocked.dispatched, true, JSON.stringify(blocked));
  sql.prepare("UPDATE neo_todos SET state='todo' WHERE id='todo'").run();
  const pending = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(pending.dispatched, true, JSON.stringify(pending));
  sql.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,named,state,approved_at,desktop_apps,created_at,updated_at) VALUES('older','ask',1,'Older task','Observed',?, 'blocked',?,?,?,?)").run(JSON.stringify({ desktopControl: true }), now, fixtureApps, now, now);
  sql.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run('older', JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: worker }));
  sql.prepare("UPDATE neo_todos SET state='doing' WHERE id='todo'").run();
  const current = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(current.dispatched, true, JSON.stringify(current));
  const currentAudit = sql.prepare("SELECT params_summary FROM mcp_audit_log WHERE tool_name='desktop.call' ORDER BY rowid DESC LIMIT 1").get() as { params_summary: string };
  assert.equal(JSON.parse(currentAudit.params_summary).todo, 'todo');
  sql.prepare("UPDATE neo_todos SET state='blocked' WHERE id='todo'").run();
  const ambiguous = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(ambiguous.reason, 'todo_ambiguous');
  assert.equal(ambiguous.dispatched, false);
  sql.prepare("UPDATE neo_todos SET state='todo', named='{}', desktop_apps=NULL WHERE id='older'").run();
  const blockedWithQueued = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(blockedWithQueued.dispatched, true, JSON.stringify(blockedWithQueued));
  sql.prepare("UPDATE neo_todos SET state='done' WHERE id='older'").run();
  sql.prepare("UPDATE neo_todos SET state='done' WHERE id='todo'").run();
  const finished = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(finished.reason, 'todo_not_active');
  assert.equal(finished.dispatched, false);
  assert.equal(requests.length, 6);
  sql.prepare("UPDATE neo_todos SET state='doing' WHERE id='todo'").run();
  hostBusy = true;
  const busy = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(busy.reason, 'desktop_busy');
  assert.equal(busy.dispatched, false);
  assert.equal(requests.length, 7);
  hostBusy = false;
  hostTimeout = true;
  const expired = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(expired.reason, 'desktop_timeout');
  assert.equal(expired.dispatched, false);
  assert.equal(requests.length, 8);
  hostTimeout = false;
  const sibling = await app.sessionManager.createSession({ workspacePath: run, title: 'Synthetic sibling worker' });
  const siblingCall = operationInvoke(app.sessionManager.getSession(sibling)!.getOperationMcpServer());
  sql.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,named,state,approved_at,created_at,updated_at) VALUES('sibling','ask',2,'Sibling task','Observed','{}','doing',?,?,?)").run(now, now, now);
  sql.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run('sibling', JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: sibling }));
  const isolated = JSON.parse((await siblingCall({ name: 'desktop.call', input })).content[0].text);
  assert.equal(isolated.reason, 'desktop_not_enabled');
  assert.equal(isolated.dispatched, false);
  assert.equal(requests.length, 8);
  sql.prepare("UPDATE neo_todos SET desktop_apps=? WHERE id='sibling'").run(JSON.stringify([{ bundleId: 'org.example.other', name: 'Other' }]));
  const siblingApproved = JSON.parse((await siblingCall({ name: 'desktop.call', input })).content[0].text);
  assert.equal(siblingApproved.dispatched, true, JSON.stringify(siblingApproved));
  assert.equal(requests.length, 9);
  assert.deepEqual(requests[8].apps, ['org.example.other']);
  assert.deepEqual(requests[7].apps, ['org.example.fixture']);
  hostLocked = true;
  const locked = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'screen_locked');
  assert.equal(locked.dispatched, false);
  const lockedAudit = sql.prepare("SELECT params_summary FROM mcp_audit_log WHERE tool_name='desktop.call' ORDER BY rowid DESC LIMIT 1").get() as { params_summary: string };
  assert.equal(JSON.parse(lockedAudit.params_summary).reason, 'screen_locked');
  hostLocked = false;
  const resumed = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(requests.length, 11);
  writeFileSync(join(run, 'evidence/desktop-call.json'), JSON.stringify({ passed: true, hostRequests: requests.length, auditRows: audited.length, hostBusy: true, hostTimeout: true, blockedAllowed: true, pendingAllowed: true, currentPreferred: true, ambiguousRefused: true, blockedWithQueuedAllowed: true, finishedRefused: true, driverErrorBody: true, rpcRefused: true, sessionDoorRefused: true, spoofRefused: true, unlistedRefused: true, unapprovedRefused: true, noScopeRefused: true, siblingIsolated: true, siblingOwnScope: true, hostLocked: true, resumed: true, describedTools: listedTools.length }, null, 2));
  console.log(`desktop.call journey PASS host_requests=11 no_scope_refused=1 sibling_isolated=1 sibling_own_scope=1 host_busy=1 host_timeout=1 host_locked=1 resumed=1 initial_audit_rows=2 blocked_allowed=1 pending_allowed=1 current_preferred=1 ambiguous_refused=1 blocked_with_queued_allowed=1 finished_refused=1 driver_error_body=1 refused_paths=5 described_tools=${listedTools.length}`);

  await transport.connect();
  await agent.stateManager.setProcessing('fixture-input');
  let turn = new DesktopTurn();
  const invokeTurn = operationInvoke(agent.getOperationMcpServer(undefined, () => turn));
  const dispatch = async () => JSON.parse((await invokeTurn({ name: 'desktop.call', input })).content[0].text);
  holdDispatch = true;
  const inFlight = dispatch();
  const refuseInFlight = await Promise.race([
    pendingDispatch.promise,
    inFlight.then((reply) => { throw new Error(`Desktop dispatch completed early: ${JSON.stringify(reply)}`); }),
  ]);
  holdDispatch = false;
  const first = requests.at(-1)!;
  let stopSettled = false;
  const stopWork = () => hub.request('operation.invoke', {
    name: 'work.stop',
    input: { ref: { adapter: 'hyperneo', id: worker } },
  });
  const stop = stopWork().finally(() => { stopSettled = true; });
  const acknowledge = await Promise.race([
    cancelTurn.promise,
    stop.then((response) => { throw new Error(`Work stop returned without Desktop acknowledgment: ${JSON.stringify(response)}`); }),
  ]);
  try {
    assert.deepEqual(requests.at(-1), { action: 'cancelTurn', worker, callIds: [first.callId] });
    await delay(50);
    assert.equal(stopSettled, false);
  } finally {
    acknowledge();
    refuseInFlight();
  }
  const stopped = await stop;
  assert.deepEqual(stopped, { ok: true, value: { stopped: true } });
  assert.equal((await inFlight).reason, 'turn_stopped');
  assert.deepEqual(await dispatch(), { ok: false, reason: 'turn_stopped', decision: 'refused', dispatched: false });
  assert.equal(requests.length, 13);
  turn = new DesktopTurn();
  assert.equal((await dispatch()).dispatched, true);
  assert.notEqual(requests.at(-1)!.callId, first.callId);

  legacyHost = true;
  await agent.stateManager.setProcessing('legacy-input');
  assert.equal((await dispatch()).dispatched, true);
  const stoppedWithLegacy = await stopWork();
  assert.deepEqual(stoppedWithLegacy, stopped);
  assert.deepEqual(requests.at(-1), { action: 'cancelTurn', worker, callIds: [] });
  assert.equal((await dispatch()).reason, 'turn_stopped');
  turn = new DesktopTurn();
  assert.equal((await dispatch()).dispatched, true);
  assert.equal(requests.length, 17);
  writeFileSync(join(run, 'evidence/desktop-turn-stop.json'), JSON.stringify({ stopped, stoppedWithLegacy, revokedTurnRefused: true, nextTurnDispatched: true, hostRequests: requests.length - 11 }, null, 2));
  console.log('work.stop journey PASS stop_waited_for_host=1 revoked_turn_refused=1 next_turn_dispatched=1 legacy_stop_degraded=1 host_requests=6');
} finally {
  await transport.close();
  await new Promise<void>(done => host.close(() => done()));
  await app.cleanup();
}
