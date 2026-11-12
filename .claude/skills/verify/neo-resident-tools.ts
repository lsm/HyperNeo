process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createOperationRpcHandler } from '../../../packages/daemon/src/lib/operations/rpc-adapter.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { NEO_RESIDENT_FAMILIES, residentOperation } from '../../../packages/daemon/src/lib/operations/resident-tools.ts';
import { operationsCapabilityContribution } from '../../../packages/daemon/src/lib/operations/door-briefing.ts';
import { createOperationRegistry, defineOperation } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { z } from '../../../packages/daemon/node_modules/zod/index.js';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
copyFileSync(new URL('./gh-stub.sh', import.meta.url), join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
const evidence: unknown[] = [];
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const registry = app.sessionManager.getOperationRegistry();
  const rpc = createOperationRpcHandler(registry, () => ({}));
  const root = await rpc({ name: 'neo.open', input: {} }, { messageId: 'proof', sessionId: 'global', method: 'operation.invoke', timestamp: 'proof' });
  assert(root.sessionId);
  const server = createOperationMcpServer(registry, () => ({ role: 'neo', sessionId: root.sessionId }), undefined, 'neo');
  const client = new Client({ name: 'resident-proof', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(right);
  await client.connect(left);
  try {
    const tools = (await client.listTools()).tools;
    assert(tools.find(tool => tool.name === 'invoke')!.description!.includes('message.send acceptance means durable mailbox persistence, not an agent reply'));
    const names = tools.map(({ name }) => name).sort();
    assert.deepEqual(names, ['invoke', ...NEO_RESIDENT_FAMILIES.map(({ name }) => name)].sort());
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: args });
      assert(Array.isArray(reply.content));
      const text = reply.content[0] as { text: string };
      let value: unknown;
      try { value = JSON.parse(text.text); } catch { assert.equal(reply.isError, true); value = text.text; }
      return { value: value as Record<string, unknown>, isError: reply.isError === true };
    };
    const invoke = (name: string, input: Record<string, unknown>) => call('invoke', { name, input });
    let routes = 0;
    for (const family of NEO_RESIDENT_FAMILIES) {
      for (const action of family.actions) {
        const name = residentOperation(family, action);
        assert(registry.get(name), name);
        const described = await invoke('operations.describe', { name });
        assert.equal(described.value.found, true);
        const input = { proof: true };
        const wrapped = await call(family.name, { ...(family.actions.length > 1 ? { action } : {}), input });
        const canonical = await invoke(name, input);
        assert.deepEqual(wrapped, canonical, name);
        routes++;
      }
    }
    assert.equal(routes, 28);
    assert.equal((await call('neo_todo', { action: 'start', input: {} })).isError, true);
    const opened = await call('neo_ask', { action: 'open', input: { title: 'Resident proof', request: 'Check resident routing' } });
    assert.equal(opened.isError, false);
    assert.equal(opened.value.ok, true);
    const askId = (opened.value.ask as { id: string }).id;
    const read = await invoke('neo.ask.read', { askId });
    assert.equal(read.value.ok, true);
    assert.equal(((read.value.entry as { ask: { title: string } }).ask).title, 'Resident proof');
    evidence.push({ opened, read });
    const index = await invoke('operations.list', {});
    assert.deepEqual(await invoke('operations.list', { all: true }), index);
    const door = operationsCapabilityContribution(server, { get: registry.get, get entries(): never { throw new Error('Neo briefing must not enumerate operations'); } }, { source: 'mcp', role: 'neo' }).briefing;
    const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const bytes = Buffer.byteLength(JSON.stringify({ tools: definitions, door }));
    const listBytes = Buffer.byteLength(JSON.stringify(index.value));
    evidence.push({ tools: definitions, door, bytes, listBytes, routes });
    assert(bytes < 3100, `tool definitions plus door: ${bytes}`);
    assert(listBytes < 500, `list: ${listBytes}`);
    console.log(`PASS tools=${tools.length} routes=${routes} bytes=${bytes} listBytes=${listBytes}`);

  } finally {
    await client.close();
    await server.instance.close();
  }

  let guardedExecutions = 0;
  const guardRegistry = createOperationRegistry(['neo.publication.publish', 'neo.session.archive', 'neo.speech.say'].map(name => defineOperation({
    name, description: name, inputSchema: z.object({ text: z.string() }), resultSchema: z.unknown(),
    execute: async () => { guardedExecutions++; return {}; },
  })));
  const guardServer = createOperationMcpServer(guardRegistry, () => ({ role: 'neo' }), undefined, 'neo');
  const guardClient = new Client({ name: 'single-action-proof', version: '1' });
  const [guardLeft, guardRight] = InMemoryTransport.createLinkedPair();
  try {
    await guardServer.instance.connect(guardRight);
    await guardClient.connect(guardLeft);
    for (const name of ['neo_publish', 'neo_session', 'neo_speech']) {
      const reply = await guardClient.callTool({ name, arguments: { action: 'wrong', input: { text: 'valid' } } });
      assert.equal(reply.isError, true, name);
    }
    assert.equal(guardedExecutions, 0);
    evidence.push({ guardedExecutions, rejectedSingleActions: 3 });
  } finally {
    await guardClient.close();
    await guardServer.instance.close();
  }
  const other = createOperationMcpServer(registry, () => ({ role: 'workflow_worker' }));
  const otherClient = new Client({ name: 'non-neo-proof', version: '1' });
  const [otherLeft, otherRight] = InMemoryTransport.createLinkedPair();
  try {
    await other.instance.connect(otherRight);
    await otherClient.connect(otherLeft);
    assert.deepEqual((await otherClient.listTools()).tools.map(({ name }) => name), ['invoke']);
    evidence.push({ nonNeoTools: 1 });
  } finally {
    await otherClient.close();
    await other.instance.close();
  }

} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
