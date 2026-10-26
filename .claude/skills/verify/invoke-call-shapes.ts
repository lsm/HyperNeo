import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { Database } from '../../../packages/daemon/src/storage/database.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';
import { InternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createNeoOperations } from '../../../packages/daemon/src/lib/neo/operations.ts';
import { createFindWorkOperation } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { operationSignature } from '../../../packages/daemon/src/lib/operations/discovery.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import type { SessionManager } from '../../../packages/daemon/src/lib/session/session-manager.ts';
import { MessageHub } from '../../../packages/shared/src/mod.ts';
import { AgentSession } from '../../../packages/daemon/src/lib/agent/agent-session.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const db = new Database(':memory:');
await db.initialize(createReactiveDatabase(db));
const service = createNeoService(db,
  { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
  { event: () => {} } as unknown as MessageHub, new InternalEventBus());
const remote = { list: () => [], invoke: async (): Promise<never> => { throw new Error('No remote calls'); } };
const registry = createOperationRegistry([
  ...createNeoOperations(service),
  ...createWorkVerbOperations({ adapters: () => [], remote, daemonName: 'synthetic' }),
  createFindWorkOperation({ adapters: () => [], remote }),
]);
const record = {
  id: 'role-proof', title: 'Neo', workspacePath: run,
  createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active' as const,
  config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
  metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
};
await db.createSession(record);
const hub = new MessageHub();
const session = AgentSession.restore(record.id, db, hub, new InternalEventBus(), async () => null,
  undefined, undefined, { autoReplayPendingMessages: false })!;
session.setOperationRegistryProvider(() => registry);
const roleClients = new Map<ReturnType<typeof session.getOperationMcpServer>, Client>();
async function observeRole() {
  const attached = session.getOperationMcpServer();
  let reader = roleClients.get(attached);
  if (!reader) {
    reader = new Client({ name: 'role-transition-proof', version: '1' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await attached.instance.connect(serverSide);
    await reader.connect(clientSide);
    roleClients.set(attached, reader);
  }
  return reader.listTools();
}
const server = createOperationMcpServer(() => registry, () => ({ role: 'neo', sessionId: 'synthetic' }), undefined, 'neo');
const plainServer = createOperationMcpServer(() => registry, () => ({ sessionId: 'plain' }));
const plainClient = new Client({ name: 'plain-shapes-proof', version: '1' });
const [plainA, plainB] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'invoke-shapes-proof', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  const transitions = [await observeRole()];
  const base = transitions[0].tools[0].description;
  session.setCallerScopeResolver(() => ({ role: 'neo' }));
  transitions.push(await observeRole());
  writeFileSync(join(run, 'evidence/role-transitions.json'), JSON.stringify(transitions, null, 2));
  assert(transitions[1].tools[0].description!.includes('Core input shapes:'), 'Cached plain server must refresh after resolver replacement');
  let role: 'neo' | undefined;
  session.setCallerScopeResolver(() => ({ role }));
  transitions.push(await observeRole());
  assert.equal(transitions.at(-1)!.tools[0].description, base);
  role = 'neo';
  transitions.push(await observeRole());
  assert(transitions.at(-1)!.tools[0].description!.includes('Core input shapes:'), 'Cached server must follow a changed scope from the same resolver');
  role = undefined;
  transitions.push(await observeRole());
  assert.equal(transitions.at(-1)!.tools[0].description, base);
  writeFileSync(join(run, 'evidence/role-transitions.json'), JSON.stringify(transitions, null, 2));
  console.log('PASS: actual session MCP discovery follows resolver replacement and mutable role changes in both directions.');
  await server.instance.connect(b);
  await client.connect(a);
  const listed = await client.listTools();
  writeFileSync(join(run, 'evidence/tools.json'), JSON.stringify(listed, null, 2));
  assert.deepEqual(listed.tools.map(tool => tool.name), ['invoke']);
  const description = listed.tools[0].description!;
  for (const name of ['work.send', 'neo.publication.publish', 'neo.todo.add', 'neo.todo.continue', 'neo.todo.edit', 'neo.github.read', 'neo.question.ask', 'neo.ask.settle', 'neo.snapshot', 'work.find', 'neo.ask.open', 'neo.todo.close', 'neo.question.get']) {
    assert(description.includes(name), `Missing ${name}`);
  }
  assert(description.length < 3000, 'Description must remain compact');
  const aliases = new Map(
    description.split('\n').filter(line => /^T\d+=/.test(line)).map(line => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    })
  );
  for (const line of description.split('\n').filter(line => /^(work|neo)\./.test(line))) {
    const name = line.slice(0, line.indexOf(' '));
    const expanded = line.split(';')[0].replace(/\bT\d+\b/g, alias => aliases.get(alias)!);
    assert.equal(expanded, operationSignature(registry.get(name)!, true));
  }
  assert(description.includes('"bind"'));
  assert(description.includes('questionId'));
  assert(description.includes('shortText'));
  await plainServer.instance.connect(plainB);
  await plainClient.connect(plainA);
  const plainListed = await plainClient.listTools();
  writeFileSync(join(run, 'evidence/plain-tools.json'), JSON.stringify(plainListed, null, 2));
  assert.deepEqual(plainListed.tools.map(tool => tool.name), ['invoke']);
  assert.equal(plainListed.tools[0].description, description.split('\n\nCore input shapes:')[0]);
  console.log('PASS: plain session MCP tools/list retains the unaugmented description.');
  console.log(`PASS: one invoke tool advertises live core shapes through MCP tools/list (${description.length} characters).`);
} finally {
  for (const [attached, reader] of roleClients) {
    await reader.close();
    await attached.instance.close();
  }
  await session.cleanup();
  hub.cleanup();
  await plainClient.close();
  await plainServer.instance.close();
  await client.close();
  await server.instance.close();
  await db.close();
}
