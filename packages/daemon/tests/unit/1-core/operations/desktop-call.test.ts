import { afterEach, beforeEach, expect, test } from 'vitest';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDesktopCallOperation,
  decideDesktopCall,
} from '../../../../src/lib/desktop/call-operation.ts';
import catalog from '../../../../src/lib/desktop/tool-catalog.json' with { type: 'json' };
import { describeOperationDefinition } from '../../../../src/lib/operations/discovery.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { planSessionDoorCall } from '../../../../src/lib/messaging/session-door.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

let db: Database;
let root: string;
let server: Server;
let requests: Record<string, unknown>[];
let reason: string | null;
let dispatched: boolean;
let workspace: string | null;
let worktree: string | undefined;
let mismatchedReply: boolean;
let body: { content?: Record<string, unknown>[]; structuredContent?: unknown };
const caller: OperationCaller = {
  source: 'mcp',
  sessionId: 'worker-a',
  role: 'universal_read',
};
const input = { tool: 'click', args: { pid: 123 } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-call-'));
  workspace = root;
  worktree = undefined;
  mismatchedReply = false;
  body = {};
  await mkdir(join(root, 'desktop'));
  db = new Database(':memory:');
  db.exec(`CREATE TABLE neo_asks(id TEXT, status TEXT);
    CREATE TABLE neo_todos(id TEXT, ask_id TEXT, title TEXT, state TEXT, approved_at INTEGER, named TEXT);
    CREATE TABLE neo_todo_sessions(todo_id TEXT, ref TEXT);
    CREATE TABLE mcp_audit_log(id TEXT, timestamp INTEGER, agent_name TEXT, session_id TEXT, tool_name TEXT, params_summary TEXT, space_id TEXT, task_id TEXT, workflow_run_id TEXT);
    INSERT INTO neo_asks VALUES('ask','open');
    INSERT INTO neo_todos VALUES('todo','ask','Synthetic action','doing',1,'{"desktopControl":true}');
    INSERT INTO neo_todo_sessions VALUES('todo','{"adapter":"hyperneo","id":"worker-a"}');`);
  requests = [];
  reason = null;
  dispatched = true;
  server = createServer((socket) => {
    let line = '';
    socket.on('data', (chunk) => {
      line += chunk;
      if (!line.includes('\n')) return;
      const request = JSON.parse(line);
      requests.push(request);
      socket.end(
        JSON.stringify({
          ok: true,
          result: {
            call_id: mismatchedReply ? 'wrong-call' : request.callId,
            bundle_id: 'org.example.app',
            class: 'pointer',
            decision: reason ? 'refused' : 'allowed',
            reason,
            dispatched,
            ...body,
          },
        }) + '\n'
      );
    });
  });
  server.listen(join(root, 'desktop/control.sock'));
  await once(server, 'listening');
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  await rm(root, { recursive: true, force: true });
});
function registry() {
  return createOperationRegistry([
    createDesktopCallOperation(db, {
      dataDir: root,
      getSession: (id) =>
        id === 'worker-a'
          ? {
              workspacePath: workspace,
              ...(worktree
                ? {
                    worktree: {
                      isWorktree: true,
                      worktreePath: worktree,
                      mainRepoPath: root,
                      branch: 'fixture',
                    },
                  }
                : {}),
            }
          : null,
    }),
  ]);
}
const call = (identity = caller, args: unknown = input) =>
  invokeOperation(registry(), 'desktop.call', args, identity);
const audit = () =>
  db.prepare("SELECT * FROM mcp_audit_log WHERE tool_name='desktop.call'").all() as Array<{
    session_id: string;
    params_summary: string;
    timestamp: number;
  }>;

test.each(['universal_read', 'direct_task_worker'] as const)(
  'in-process MCP dispatch from a %s todo worker uses only its session and workspace',
  async (role) => {
    const handler = createOperationMcpHandler(registry(), () => ({ sessionId: 'worker-a', role }));
    const response = await handler({ name: 'desktop.call', input });
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      dispatched: true,
      decision: 'allowed',
    });
    expect(requests).toEqual([
      expect.objectContaining({
        action: 'dispatch',
        worker: 'worker-a',
        workDir: root,
        tool: 'click',
        arguments: { pid: 123 },
      }),
    ]);
    expect(audit()).toHaveLength(1);
    expect(JSON.parse(audit()[0].params_summary)).toEqual({
      todo: 'todo',
      session: 'worker-a',
      tool: 'click',
      app: 'org.example.app',
      class: 'pointer',
      decision: 'allowed',
      reason: null,
      dispatched: true,
    });
    expect(audit()[0].timestamp).toBeGreaterThan(0);
  }
);

test('a driver error reaches the session with the driver message and screenshot', async () => {
  reason = 'driver_error';
  body = {
    content: [
      { type: 'text', text: 'Call get_window_state first' },
      { type: 'image', data: 'aW1n', mimeType: 'image/png' },
    ],
    structuredContent: { code: 'no_screenshot' },
  };
  const handler = createOperationMcpHandler(registry(), () => ({
    sessionId: 'worker-a',
    role: 'direct_task_worker',
  }));
  const response = await handler({ name: 'desktop.call', input });
  expect(JSON.parse(response.content[0].text)).toMatchObject({
    ok: false,
    reason: 'driver_error',
    structuredContent: { code: 'no_screenshot' },
  });
  expect(response.content.slice(1)).toEqual(body.content);
  expect(response.isError).toBe(true);
});

test('a full-window screenshot larger than 2 MiB reaches the session', async () => {
  body = { content: [{ type: 'image', data: 'A'.repeat(3 << 20), mimeType: 'image/png' }] };
  const handler = createOperationMcpHandler(registry(), () => ({
    sessionId: 'worker-a',
    role: 'direct_task_worker',
  }));
  const response = await handler({ name: 'desktop.call', input });
  expect(JSON.parse(response.content[0].text)).toMatchObject({ ok: true });
  expect(response.content[1]).toEqual(body.content?.[0]);
  expect(response.isError).toBeFalsy();
});

test.each([
  { source: 'rpc', principal: 'local', sessionId: 'worker-a', role: 'direct_task_worker' },
  { source: 'internal', sessionId: 'worker-a', role: 'direct_task_worker' },
  { source: 'mcp', principal: 'session-door', sessionId: 'worker-a', role: 'direct_task_worker' },
  { source: 'mcp', principal: 'session-door', sessionId: 'worker-a', role: 'universal_read' },
  { source: 'rpc', principal: 'local', sessionId: 'worker-a', role: 'universal_read' },
  { source: 'mcp', sessionId: 'worker-a' },
  { source: 'mcp', role: 'direct_task_worker' },
] as OperationCaller[])(
  'refuses caller $source/$role/$principal before contacting the host',
  async (identity) => {
    expect(await call(identity)).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'desktop_not_enabled', dispatched: false },
    });
    expect(requests).toHaveLength(0);
    expect(audit()).toHaveLength(0);
  }
);

test.each([
  "UPDATE neo_todos SET named='{}'",
  'UPDATE neo_todos SET approved_at=NULL',
  "UPDATE neo_todos SET state='todo'",
  "UPDATE neo_asks SET status='closed'",
  `INSERT INTO neo_todos VALUES('second','ask','Other','doing',1,'{"desktopControl":true}'); INSERT INTO neo_todo_sessions VALUES('second','{"adapter":"hyperneo","id":"worker-a"}')`,
  `UPDATE neo_todo_sessions SET ref='{"adapter":"hyperneo","id":"worker-a","daemon":"remote"}'`,
])('refuses an uncovered or ambiguous binding before any host request', async (sql) => {
  db.exec(sql);
  expect(await call()).toMatchObject({
    kind: 'completed',
    value: { reason: 'desktop_not_enabled', dispatched: false },
  });
  expect(requests).toHaveLength(0);
});

test('missing workspace and unlisted tools cannot reach resolve or a grant dialog', async () => {
  workspace = null;
  expect(await call()).toMatchObject({
    kind: 'completed',
    value: { reason: 'desktop_not_enabled' },
  });
  workspace = root;
  for (const args of [
    { tool: 'kill_app', args: {} },
    { tool: 'click', args: { pid: 'not-a-pid' } },
    { tool: 'type_text', args: {} },
  ]) {
    expect(await call(caller, args)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  }
  expect(requests).toHaveLength(0);
});

test('operations.describe lists every catalog tool with its arguments', () => {
  const operation = registry().get('desktop.call')!;
  const described = JSON.stringify(describeOperationDefinition(operation));
  for (const tool of catalog) {
    expect(described).toContain(`"const":"${tool.name}"`);
    expect(described).toContain(tool.description);
  }
  expect(described).toContain('"window_id"');
});

test('input cannot impersonate a different worker or choose a workspace', async () => {
  for (const field of [{ worker: 'other' }, { sessionId: 'other' }, { workDir: '/tmp/other' }]) {
    expect(await call(caller, { ...input, ...field })).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
  }
  expect(requests).toHaveLength(0);
  expect(planSessionDoorCall({ sender: 'worker-a', name: 'desktop.call', input })).toHaveProperty(
    'reason'
  );
});

test('host refusal and a sent driver error each produce one truthful audit row', async () => {
  reason = 'app_action_not_authorized';
  dispatched = false;
  expect(await call()).toMatchObject({ kind: 'completed', value: { reason, dispatched: false } });
  reason = 'driver call timed out';
  dispatched = true;
  expect(await call()).toMatchObject({ kind: 'completed', value: { reason, dispatched: true } });
  expect(audit().map((row) => JSON.parse(row.params_summary))).toEqual([
    expect.objectContaining({ reason: 'app_action_not_authorized', dispatched: false }),
    expect.objectContaining({ reason: 'driver call timed out', dispatched: true }),
  ]);
  expect(audit().every((row) => !row.params_summary.includes('123'))).toBe(true);
});

test('the pure decision refuses a missing binding or workspace', () => {
  const todo = { id: 'todo', worker: 'worker-a', title: 'Synthetic', named: '{}', active: 1 };
  const facts = { todo, worker: 'worker-a', workDir: root };
  expect(decideDesktopCall(facts)).toEqual({
    value: { todo: 'todo', worker: 'worker-a', workDir: root },
  });
  expect(decideDesktopCall({ ...facts, todo: null })).toHaveProperty(
    'reason.reason',
    'desktop_not_enabled'
  );
  expect(decideDesktopCall({ ...facts, workDir: null })).toHaveProperty(
    'reason.reason',
    'desktop_not_enabled'
  );
});

test('a session worktree is the dispatch working directory', async () => {
  worktree = join(root, 'worktree');
  expect(await call()).toMatchObject({ kind: 'completed', value: { dispatched: true } });
  expect(requests[0].workDir).toBe(worktree);
});

test('an uncorrelated host reply never invents an audit outcome', async () => {
  mismatchedReply = true;
  expect(await call()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
  expect(requests).toHaveLength(1);
  expect(audit()).toHaveLength(0);
});
