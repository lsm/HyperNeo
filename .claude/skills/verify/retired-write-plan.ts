process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const evidence: unknown[] = [];
let client: Client | undefined;
let server: ReturnType<typeof createOperationMcpServer> | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const registry = app.sessionManager.getOperationRegistry();
  server = createOperationMcpServer(registry, () => ({ role: 'neo', sessionId: 'synthetic' }), undefined, 'neo');
  client = new Client({ name: 'retirement-proof', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(right);
  await client.connect(left);
  const call = async (name: string, input: unknown) => {
    const reply = await client!.callTool({ name: 'invoke', arguments: { name, input } });
    assert(Array.isArray(reply.content));
    return JSON.parse((reply.content[0] as { text: string }).text);
  };
  const settings = new SettingsRepository(app.db.getDatabase());
  for (const packs of [[], ['coding']]) {
    settings.updateGlobalSettings({ neo: { ...settings.getGlobalSettings().neo, packs } });
    assert.equal(registry.get('neo.coding.write.plan'), undefined);
    assert(registry.get('neo.coding.assign'));
    assert.equal((await call('neo.coding.write.plan', {})).code, 'unknown_operation');
    assert.equal((await call('operations.describe', { name: 'neo.coding.write.plan' })).found, false);
    assert.deepEqual(await call('operations.list', { prefix: 'neo.coding.write', all: true }), { total: 0, names: [], next: null });
    evidence.push({ packs, retired: true, codingAssignmentPresent: true });
  }
  console.log(`PASS registry=${registry.entries.length} retiredOperations=1 packStates=2 codingAssignmentPresent=true`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await client?.close();
  await server?.instance.close();
  await app.cleanup();
}
