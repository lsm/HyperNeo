process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
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
  const server = createOperationMcpServer(registry, () => ({ role: 'neo', sessionId: 'synthetic-neo' }), undefined, 'neo');
  const client = new Client({ name: 'resident-proof', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(right);
  await client.connect(left);
  try {
    const tools = (await client.listTools()).tools;
    evidence.push({ tools });
    assert.deepEqual(tools.map(({ name }) => name).sort(), ['invoke', 'neo_work', 'neo_todo', 'neo_publish', 'neo_ask', 'neo_question', 'neo_session', 'neo_speech'].sort());
  } finally {
    await client.close();
    await server.instance.close();
  }

} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
