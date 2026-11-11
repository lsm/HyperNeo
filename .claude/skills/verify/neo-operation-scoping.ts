process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createOperationRpcHandler } from '../../../packages/daemon/src/lib/operations/rpc-adapter.ts';
import { listOperationSummaries } from '../../../packages/daemon/src/lib/operations/discovery.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';

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
  const mcp = createOperationMcpHandler(registry, () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
  const call = async (name: string, input: unknown) => {
    const reply = await mcp({ name, input });
    const value = JSON.parse(reply.content[0].text);
    evidence.push({ name, input, value });
    return value;
  };
  const roleGated = registry.entries.find((entry) => entry.policy?.roles?.includes('workflow_worker') && !entry.policy.roles.includes('neo'));
  assert(roleGated, 'real workflow-only operation exists');
  assert.equal((await call(roleGated.name, {})).code, 'forbidden');
  const settings = new SettingsRepository(app.db.getDatabase());
  const initial = settings.getGlobalSettings();
  settings.updateGlobalSettings({ neo: { ...initial.neo, packs: [] } });
  assert.equal((await call('neo.coding.pr.file', {})).code, 'forbidden');
  assert.equal((await call('operations.describe', { name: 'neo.coding.pr.file' })).found, false);
  const disabled = await call('operations.list', { prefix: 'neo.coding.pr', all: true });
  assert.deepEqual(disabled, { total: 0, names: [], next: null });
  const index = await call('operations.list', {});
  assert(Array.isArray(index.prefixes));
  assert.deepEqual(await call('operations.list', { all: true }), index);
  assert.deepEqual(await call('operations.list', { cursor: 'neo.ask.history' }), index);
  const neoListDescription = await call('operations.describe', { name: 'operations.list' });
  assert(neoListDescription.description.includes('all: true stays compact'));
  assert(neoListDescription.description.includes('at most 20 names'));
  assert(neoListDescription.inputSchema.properties.cursor.description.includes('Without prefix, Neo returns namespace counts and ignores cursor.'));
  const rpc = createOperationRpcHandler(registry, () => ({}));
  const humanListDescription = await rpc({ name: 'operations.describe', input: { name: 'operations.list' } }, { messageId: 'description-proof', sessionId: 'global', method: 'operation.invoke', timestamp: 'proof' });
  assert.equal(humanListDescription.description, registry.get('operations.list')!.description);
  evidence.push({ humanListDescription, descriptionParity: true });
  const human = await rpc({ name: 'operations.list', input: { all: true } }, { messageId: 'proof', sessionId: 'global', method: 'operation.invoke', timestamp: 'proof' });
  assert.equal(JSON.stringify(human), JSON.stringify(listOperationSummaries(registry, { source: 'rpc', principal: 'local' }, true)));
  assert(Array.isArray(human));
  assert(human.some((entry: { name: string }) => entry.name === 'neo.coding.pr.file'));
  evidence.push({ humanRpcCount: human.length, byteParity: true, indexBytes: Buffer.byteLength(JSON.stringify(index)) });
  const typo = await call('neo.coding.pr.filee', {});
  assert(!typo.message.includes('neo.coding.pr.file,'));
  assert(!typo.message.includes('neo.coding.pr.file?'));
  settings.updateGlobalSettings({ neo: { ...initial.neo, packs: ['coding'] } });
  assert.equal((await call('operations.describe', { name: 'neo.coding.pr.file' })).found, true);
  const enabled = await call('operations.list', { prefix: 'neo.coding.pr' });
  assert.deepEqual(enabled, { total: 1, names: ['neo.coding.pr.file'], next: null });
  const first = await call('operations.list', { prefix: 'neo' });
  assert(first.names.length <= 20);
  if (first.next) {
    const next = await call('operations.list', { prefix: 'neo', cursor: first.next });
    assert(next.names.every((name: string) => name > first.next));
    assert.equal(next.total, first.total);
  }
  evidence.push({ firstPageBytes: Buffer.byteLength(JSON.stringify(first)) });
  const read = await call('neo.coding.pr.file', { url: 'https://github.com/example/project/pull/1' });
  assert.notEqual(read.code, 'forbidden');
  assert.equal(read.code, 'invalid_input');
  assert.notEqual(read.code, 'execution_failed');
  console.log(`PASS registry=${registry.entries.length} disabled=${disabled.total} enabled=${enabled.total} humanRpc=${human.length}`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
