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
import type { MessageHub } from '../../../packages/shared/src/mod.ts';

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
const server = createOperationMcpServer(() => registry, () => ({ role: 'neo', sessionId: 'synthetic' }), undefined, 'neo');
const plainServer = createOperationMcpServer(() => registry, () => ({ sessionId: 'plain' }));
const plainClient = new Client({ name: 'plain-shapes-proof', version: '1' });
const [plainA, plainB] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'invoke-shapes-proof', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
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
  await plainClient.close();
  await plainServer.instance.close();
  await client.close();
  await server.instance.close();
  await db.close();
}
