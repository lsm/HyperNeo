import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.notEqual(process.env.HYPERNEO_SPACE, 'on');
for (const name of ['workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });

const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { createLocalSocket } = await import(
  '../../../packages/daemon/src/lib/pairing/local-credential.ts'
);
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');

const evidence: Record<string, unknown> = {};
const config = {
  ...getConfig({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(run, 'data/daemon.db'),
    workspaceRoot: join(run, 'workspace'),
  }),
  disableWorktrees: true,
  disableGoalProcessing: true,
};
const app = await createDaemonApp({ config, verbose: false });
const client = new Client({ name: 'session-events-proof', version: '1' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: (address) => createLocalSocket(address, join(run, 'data/local-rpc.credential')),
});
try {
  assert.notEqual(app.server.port, 8399);
  const raw = app.db.getDatabase();
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[]).map((row) => row.name);
  evidence.spaceSubscriptionTable = tables.includes('space_session_event_subscriptions');
  evidence.spaceEventTables = tables.filter((name) => name.startsWith('space_external_'));
  assert.equal(evidence.spaceSubscriptionTable, false);
  assert.deepEqual(evidence.spaceEventTables, []);
  assert(tables.includes('session_event_subscriptions'));
  assert(tables.includes('session_external_events'));

  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerTransport(transport);
  await transport.initialize();
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'),
    config: { queryMode: 'manual' },
  });
  const agent = await app.sessionManager.getSessionAsync(sessionId);
  assert(agent);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await agent.getOperationMcpServer().instance.connect(left);
  await client.connect(right);
  const invoke = async (name: string, input: unknown = {}) => {
    const reply = await client.callTool({ name: 'invoke', arguments: { name, input } });
    const text = (reply.content as { text: string }[])[0].text;
    assert(!reply.isError, `${name}: ${text}`);
    return JSON.parse(text);
  };

  evidence.subscribe = await invoke('event.external.subscribe', { topicPattern: 'proof/*' });
  evidence.list = await invoke('event.external.subscription.list');
  evidence.missing = await invoke('event.external.get', { eventId: 'missing' });
  evidence.deliveries = await invoke('event.external.delivery.list');
  evidence.unsubscribe = await invoke('event.external.unsubscribe', { topicPattern: 'proof/*' });
  evidence.after = await invoke('event.external.subscription.list');
  assert.equal(evidence.missing, 'event_not_found');
  assert.equal(evidence.subscribe.ok, true);
  assert.equal(evidence.unsubscribe.ok, true);
  assert.deepEqual(evidence.after.stored, []);
  writeFileSync(join(run, 'evidence/replies.json'), JSON.stringify(evidence, null, 2).replaceAll(sessionId, '<session>').replace(/(\"createdAt\": )\d+/g, '$1\"<time>\"'));
  console.log('Session event replies: 6');
} finally {
  await client.close().catch(() => {});
  await transport.close();
  await app.cleanup();
}
