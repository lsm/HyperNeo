import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import catalog from '../../../packages/daemon/src/lib/desktop/tool-catalog.json' with { type: 'json' };
import { operationInvoke } from '../../../packages/daemon/tests/helpers/operation-mcp.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { planSessionDoorCall } from '../../../packages/daemon/src/lib/messaging/session-door.ts';

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
    const body = request.tool === 'get_window_state' ? { reason: 'driver_error', ...driverError } : { reason: null };
    socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: 'org.example.fixture', class: 'pointer', decision: 'allowed', dispatched: true, ...body } }) + '\n');
  });
});
try {
  await app.jobProcessor.stop();
  host.listen(join(run, 'data/desktop/control.sock'));
  await once(host, 'listening');
  const worker = await app.sessionManager.createSession({ workspacePath: run, title: 'Synthetic desktop worker' });
  const agent = app.sessionManager.getSession(worker)!;
  assert(agent);
  const sql = app.db.getDatabase();
  const now = Date.now();
  sql.prepare("INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES('ask','neo:fixture','Synthetic action','','open',?,?)").run(now, now);
  sql.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,named,state,approved_at,created_at,updated_at) VALUES('todo','ask',0,'Synthetic click','Observed',?, 'doing',?,?,?)").run(JSON.stringify({ desktopControl: true }), now, now, now);
  sql.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run('todo', JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: worker }));
  const call = operationInvoke(agent.getOperationMcpServer());
  const described = JSON.stringify(JSON.parse((await call({ name: 'operations.describe', input: { name: 'desktop.call' } })).content[0].text));
  const listedTools = catalog.filter(tool => described.includes(`"const":"${tool.name}"`));
  assert.equal(listedTools.length, catalog.length, described);
  const input = { tool: 'click', args: { pid: 123, x: 5, y: 7 } };
  const allowed = await call({ name: 'desktop.call', input });
  const reply = JSON.parse(allowed.content[0].text);
  assert.equal(reply.dispatched, true, JSON.stringify(allowed));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, 'dispatch');
  assert.equal(requests[0].worker, worker);
  assert.equal(requests[0].workDir, run);
  assert.deepEqual(requests[0].arguments, input.args);
  const audit = sql.prepare("SELECT session_id, params_summary FROM mcp_audit_log WHERE tool_name='desktop.call'").all() as Array<{ session_id: string; params_summary: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].session_id, worker);
  assert.deepEqual(JSON.parse(audit[0].params_summary), { todo: 'todo', session: worker, tool: 'click', app: 'org.example.fixture', class: 'pointer', decision: 'allowed', reason: null, dispatched: true });
  const failed = await call({ name: 'desktop.call', input: { tool: 'get_window_state', args: { pid: 123, window_id: 7 } } });
  const failure = JSON.parse(failed.content[0].text);
  assert.equal(failure.ok, false, JSON.stringify(failed));
  assert.equal(failure.reason, 'driver_error');
  assert.deepEqual(failure.structuredContent, driverError.structuredContent);
  assert.deepEqual(failed.content.slice(1), driverError.content);
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
  writeFileSync(join(run, 'evidence/desktop-call.json'), JSON.stringify({ passed: true, hostRequests: requests.length, auditRows: audit.length, driverErrorBody: true, rpcRefused: true, sessionDoorRefused: true, spoofRefused: true, unlistedRefused: true, unapprovedRefused: true, describedTools: listedTools.length }, null, 2));
  console.log(`desktop.call journey PASS host_requests=2 audit_rows=1 driver_error_body=1 refused_paths=5 described_tools=${listedTools.length}`);
} finally {
  await new Promise<void>(done => host.close(() => done()));
  await app.cleanup();
}
