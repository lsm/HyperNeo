import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws` });
hub.registerTransport(transport);
const main = app.db.getDatabase();
const prepare = main.prepare.bind(main);
let targetSqlOnMain = 0;
main.prepare = ((sql: string) => {
  if (/INSERT OR REPLACE INTO global_settings/i.test(sql)) {
    targetSqlOnMain++;
    throw new Error('global_settings write reached daemon main connection');
  }
  return prepare(sql);
}) as typeof main.prepare;
try {
  await transport.connect();
  const start = performance.now();
  const reply = await hub.request<{ success: boolean; settings: { showArchived: boolean } }>(
    'settings.global.update', { updates: { showArchived: true } }
  );
  evidence.rpcMs = performance.now() - start;
  evidence.reply = reply;
  assert.equal(reply.success, true);
  assert.equal(reply.settings.showArchived, true);
  const row = prepare('SELECT settings FROM global_settings WHERE id = 1').get() as { settings: string };
  assert.equal(JSON.parse(row.settings).showArchived, true);
  const second = await hub.request<{ settings: { showArchived: boolean; outputStyle: string } }>(
    'settings.global.update', { updates: { outputStyle: 'synthetic-style' } }
  );
  assert.equal(second.settings.showArchived, true);
  assert.equal(second.settings.outputStyle, 'synthetic-style');
  evidence.persisted = JSON.parse((prepare('SELECT settings FROM global_settings WHERE id = 1').get() as { settings: string }).settings);
  evidence.result = 'pass';
} catch (error) {
  evidence.result = 'fail';
  evidence.error = String(error);
  throw error;
} finally {
  evidence.targetSqlOnMain = targetSqlOnMain;
  main.prepare = prepare;
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/global-settings-writer.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
assert.equal(targetSqlOnMain, 0);
