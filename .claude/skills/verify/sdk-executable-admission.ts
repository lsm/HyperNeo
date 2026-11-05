process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { Session } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableWorktrees: true,
  },
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
hub.registerTransport(transport);
const evidence = { publicDoorRejected: false, storedValueRejected: false, retainedConfig: false, resourcesStopped: false };
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.initialize();
  await assert.rejects(
    hub.request('session.create', { workspacePath: join(run, 'workspace'), config: { executable: 'retired-runtime' } }),
    /does not accept config field.*executable/
  );
  evidence.publicDoorRejected = true;
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'), title: 'Synthetic executable admission', config: { queryMode: 'manual' },
  });
  const agent = app.sessionManager.getSession(sessionId)!;
  const stored = { ...agent.session.config, executable: 'retired-runtime' } as unknown as Session['config'];
  await app.db.updateSession(sessionId, { config: stored });
  agent.session.config = stored;
  await assert.rejects(agent.optionsBuilder.build(), /Unsupported stored SDK executable: retired-runtime/);
  evidence.storedValueRejected = true;
  const read = await hub.request<{ session: Session }>('session.get', { sessionId });
  assert.equal(read.session.config.executable as string, 'retired-runtime');
  evidence.retainedConfig = true;
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
} finally {
  await transport.close();
  await app.cleanup();
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/sdk-executable-admission.json'), JSON.stringify(evidence, null, 2));
}
