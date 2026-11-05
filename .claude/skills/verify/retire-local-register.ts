process.env.HYPERNEO_SPACE ??= 'on';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({createSocket: createLocalSocket,  url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { port: app.server.port };
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.initialize();
  const registry = app.sessionManager.getOperationRegistry();
  const input = { requestId: 'retired', context: { kind: 'ask', id: 'unknown' }, path: join(run, 'report.md'), title: 'No capture' };
  writeFileSync(input.path, '# Current A\n');
  const before = app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM artifact_files').get();
  assert(!registry.entries.some((op) => op.name === 'artifact.file.register'));
  await assert.rejects(hub.request('operation.invoke', { name: 'artifact.file.register', input }), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'METHOD_NOT_FOUND');
    assert.match(String(error), /Unknown operation: artifact.file.register/);
    return true;
  });
  const mcp = createOperationMcpHandler(() => registry, () => ({ sessionId: 'synthetic', role: 'neo' }));
  const result = await mcp({ name: 'artifact.file.register', input });
  assert(result.isError);
  assert.match(JSON.stringify(result), /unknown_operation/);
  assert.deepEqual(app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM artifact_files').get(), before);
  unlinkSync(input.path);
  Object.assign(evidence, { passed: true, absentFromCatalog: true, rpcUnknown: true, mcpUnknown: true, noNewRows: true });
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/retire-local-register.json'), JSON.stringify({ ...evidence, cleaned: true }, null, 2));
}
console.log(JSON.stringify(evidence));
