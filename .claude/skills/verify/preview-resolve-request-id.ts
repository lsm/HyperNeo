import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const root = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(root, 'data'));
await mkdir(join(root, 'evidence'), { recursive: true });
const seed = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-resolve.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
assert.equal(await seed.exited, 0, await new Response(seed.stdout).text());
const daemon = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(root, 'data', 'daemon.db'), workspaceRoot: root }), disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${daemon.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { port: daemon.server.port };
try {
  assert.notEqual(daemon.server.port, 8399);
  await transport.initialize();
  const tap = { sourceMessageOrCard: { kind: 'message', id: 'source' }, reference: 'report.md' };
  const receipts = () => (daemon.db.getDatabase().prepare('SELECT COUNT(*) AS count FROM artifact_files').get() as { count: number }).count;
  const attempts: unknown[] = [];
  evidence.missingIdAttempts = attempts;
  evidence.before = receipts();
  for (let index = 0; index < 2; index++) {
    try { attempts.push(await hub.request('operation.invoke', { name: 'artifact.reference.resolve', input: tap })); }
    catch (error) { attempts.push({ error: String(error) }); }
  }
  evidence.afterMissingId = receipts();
  assert.equal(evidence.afterMissingId, evidence.before, 'missing requestId retries allocated immutable receipts');
  const input = { ...tap, requestId: '11111111-1111-4111-8111-111111111111' };
  const first = await hub.request('operation.invoke', { name: 'artifact.reference.resolve', input });
  const second = await hub.request('operation.invoke', { name: 'artifact.reference.resolve', input });
  assert.deepEqual(second, first);
  assert.equal(receipts(), 1);
  evidence.keyedReceipt = first;
  evidence.afterKeyedRetries = receipts();
  evidence.passed = true;
} finally {
  await writeFile(join(root, 'evidence', 'request-id.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await daemon.cleanup();
}
