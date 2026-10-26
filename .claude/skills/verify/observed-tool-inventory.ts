import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { Server } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { ListToolsRequestSchema } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import { ObservedToolInventory } from '../../../packages/daemon/src/lib/agent/observed-tool-inventory.ts';
import { QueryAttemptRegistry } from '../../../packages/daemon/src/lib/agent/query-attempt-token.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const server = new Server({ name: 'synthetic-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'navigate', description: 'Synthetic, no browser', inputSchema: { type: 'object' } }],
}));
const client = new Client({ name: 'inventory-proof', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const registry = new QueryAttemptRegistry();
const inventory = new ObservedToolInventory();
const evidence: unknown[] = [];
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const token = registry.allocate();
  inventory.begin(token, 'sdk');
  evidence.push(inventory.snapshot());
  assert.equal(inventory.snapshot().state, 'awaiting_init');
  const listed = await client.listTools();
  const init = {
    tools: ['Read', ...listed.tools.map(tool => `mcp__browser__${tool.name}`)],
    skills: ['synthetic-browser-instructions'],
    plugins: [{ name: 'synthetic-wrapper', path: '/private/synthetic-plugin' }],
    mcp_servers: [{ name: 'browser', status: 'connected' }],
  };
  async function* scriptedSdk() { yield init; }
  for await (const message of scriptedSdk()) inventory.captureInit(token, message);
  assert.equal(inventory.snapshot().mcpServers[0].tools, null);
  inventory.captureStatus(token, [{ name: 'browser', status: 'connected', tools: listed.tools }]);
  evidence.push(inventory.snapshot());
  assert.deepEqual(inventory.snapshot().mcpServers[0].tools, ['navigate']);
  assert(inventory.snapshot().tools.includes('mcp__browser__navigate'));
  const current = registry.allocate();
  inventory.begin(current, 'sdk');
  inventory.captureInit(token, init);
  inventory.captureStatus(token, [{ name: 'stale', status: 'connected' }]);
  inventory.end(token);
  assert.equal(inventory.snapshot().state, 'awaiting_init');
  assert.deepEqual(inventory.snapshot().tools, []);
  inventory.captureInit(current, init);
  registry.invalidate(current);
  evidence.push(inventory.snapshot());
  assert.equal(inventory.snapshot().state, 'not_running');
  assert.deepEqual(inventory.snapshot().mcpServers, []);
  const acp = registry.allocate();
  inventory.begin(acp, 'acp');
  inventory.captureInit(acp, init);
  evidence.push(inventory.snapshot());
  assert.equal(inventory.snapshot().state, 'unverified');
  assert.deepEqual(inventory.snapshot().tools, []);
  assert(!JSON.stringify(evidence).includes('/private/'));
  writeFileSync(join(run, 'evidence/inventory.json'), JSON.stringify({
    projectionContractVerified: true,
    syntheticMcpProtocol: true,
    scriptedSdk: true,
    daemonCaptureWired: false,
    panelVerified: false,
    evidence,
  }, null, 2));
  console.log(`PASS projection/lifetime only: ${join(run, 'evidence/inventory.json')}`);
} finally {
  await client.close();
  await server.close();
}
