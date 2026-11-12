import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const observed: unknown[] = [];
const deliveries: Record<string, unknown>[] = [];
const app = await createDaemonApp({
  config: {
    ...getConfig({
      port: 0,
      host: '127.0.0.1',
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
let transport: WebSocketClientTransport | undefined;
let socketClosed = Promise.resolve();
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const raw = app.db.getDatabase();
  const root = `neo:${crypto.randomUUID()}`;
  const at = new Date().toISOString();
  await app.db.createSession({
    id: root,
    title: 'Synthetic delegation',
    workspacePath: run,
    createdAt: at,
    lastActiveAt: at,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0 },
  });
  new NeoRepository(raw).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  await app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  const sessions = new NeoTodoSessionRepository(raw);
  const registry = app.sessionManager.getOperationRegistry();
  const proofRegistry = createOperationRegistry(
    registry.entries.map((operation) =>
      operation.name !== 'work.start'
        ? operation
        : {
            ...operation,
            execute: async (input, caller) => {
              const request = input as Record<string, unknown>;
              deliveries.push(request);
              const inputId = await sessions.inputs.accept(
                String(request.todoId),
                caller.sessionId!,
                { verb: 'start', adapter: String(request.adapter) },
                String(request.message),
                Date.now()
              );
              const ref = {
                adapter: String(request.adapter),
                id: `synthetic-worker-${deliveries.length}`,
              };
              const receipt = { executionId: ref.id, inputId };
              await sessions.inputs.recordOutcome(inputId, { ref, receipt }, Date.now());
              return {
                ok: true,
                value: {
                  ref,
                  receipt,
                  title: 'Synthetic worker',
                  place: { machine: 'synthetic', name: 'Proof', folder: run },
                  status: 'running',
                  lastActivityAt: Date.now(),
                },
              };
            },
          }
    )
  );
  app.sessionManager.setOperationRegistryProvider(() => proofRegistry);
  transport = new WebSocketClientTransport({
    createSocket: (url) => {
      const socket = createLocalSocket(url);
      socketClosed = new Promise<void>((resolve) =>
        socket.addEventListener('close', () => resolve(), { once: true })
      );
      return socket;
    },
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  hub.registerTransport(transport);
  await transport.connect();
  const human = async (name: string, input: unknown) => {
    const reply = await hub.request('operation.invoke', { name, input });
    observed.push({ surface: 'human RPC', name, input, reply });
    return reply as { ok: boolean };
  };
  const handler = createOperationMcpHandler(
    () => app.sessionManager.getOperationRegistry(),
    () => ({ sessionId: root, role: 'neo' })
  );
  const mcp = async (name: string, input: Record<string, unknown>) => {
    const result = await handler({ name, input });
    const reply = JSON.parse(result.content[0].text);
    observed.push({ surface: 'Neo MCP', name, input, reply });
    assert(!result.isError, JSON.stringify(reply));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply;
  };
  const read = () => mcp('neo.pack.read', { id: 'delegation' });
  const facts = (text: string) => JSON.parse(text.split('Delegation preferences (data):\n')[1]);
  assert.deepEqual(facts((await read()).instructions).payment, {
    value: 'self',
    configured: false,
  });
  const ask = await mcp('neo.ask.open', {
    title: 'Delegation proof',
    request: 'Prove shared worker preferences',
    todos: [],
  });
  const start = (title: string, instruction = 'Report the synthetic task result.') =>
    mcp('neo.todo.add', { after: [],
      askId: ask.ask.id,
      title,
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/example/project/pull/1'] },
      },
      instruction,
      target: {
        verb: 'start',
        adapter: 'synthetic',
        place: { machine: 'synthetic', name: 'Proof', folder: run },
      },
      after: [],
      start: true,
    });
  const first = await start('Before preference change', 'Long task. '.repeat(2000));
  assert.equal(first.todo.state, 'doing');
  assert.equal(deliveries.length, 1);
  assert((String(deliveries[0].message).match(/Long task\./g) ?? []).length < 2000);
  assert.match(String(deliveries[0].message), /Long task\./);
  assert.match(String(deliveries[0].message), /"payment":\{"value":"self","configured":false\}/);
  const setting = {
    pack: 'delegation',
    scope: { kind: 'global', key: '' },
    key: 'payment',
    value: 'fillStop',
  };
  assert.equal((await human('pack.preferences.set', setting)).ok, true);
  assert.deepEqual(facts((await read()).instructions).payment, {
    value: 'fillStop',
    configured: true,
  });
  const denied = await handler({
    name: 'pack.preferences.set',
    input: { ...setting, value: 'confirmed' },
  });
  observed.push({ agentWriteRefusal: denied });
  assert.equal(denied.isError, true);
  const second = await start('After preference change');
  assert.equal(second.todo.state, 'doing');
  assert.equal(deliveries.length, 2);
  assert.match(String(deliveries[1].message), /"payment":\{"value":"fillStop","configured":true\}/);
  assert.match(String(deliveries[1].message), /CAPTCHAs always belong to the human/);
  assert.equal(sessions.inputs.list(first.todo.id).length, 1);
  assert.equal(sessions.inputs.list(second.todo.id).length, 1);
  observed.push({
    deliveries,
    first: sessions.inputs.list(first.todo.id),
    second: sessions.inputs.list(second.todo.id),
  });
  console.log(
    'PASS: real daemon human RPC and Neo MCP dispatch two coding todos with current delegation preferences despite an explicit coding-only pack list; agent preference writes are refused. Synthetic work.start captures delivery; no model or native worker is launched.'
  );
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  try {
    await transport?.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        socketClosed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Synthetic RPC socket did not close')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    hub.cleanup();
    await app.cleanup();
  }
}
