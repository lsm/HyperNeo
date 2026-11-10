process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
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
  assert.equal((await call('neo.github.read', {})).code, 'forbidden');
  assert.equal((await call('operations.describe', { name: 'neo.github.read' })).found, false);
  const disabled = await call('operations.list', { all: true });
  assert(!disabled.some((entry: { name: string }) => entry.name === 'neo.github.read'));
  const typo = await call('neo.github.readd', {});
  assert(!typo.message.includes('neo.github.read,'));
  assert(!typo.message.includes('neo.github.read?'));
  settings.updateGlobalSettings({ neo: { ...initial.neo, packs: ['coding'] } });
  assert.equal((await call('operations.describe', { name: 'neo.github.read' })).found, true);
  const enabled = await call('operations.list', { all: true });
  assert(enabled.some((entry: { name: string }) => entry.name === 'neo.github.read'));
  const read = await call('neo.github.read', { url: 'https://github.com/example/project/pull/1' });
  assert.notEqual(read.code, 'forbidden');
  assert.notEqual(read.code, 'invalid_input');
  assert.notEqual(read.code, 'execution_failed');
  console.log(`PASS registry=${registry.entries.length} disabled=${disabled.length} enabled=${enabled.length}`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
