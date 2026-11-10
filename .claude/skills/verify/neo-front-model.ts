import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import {
  MessageHub,
  WebSocketClientTransport,
  type ModelInfo,
} from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  createSocket: (url) => createLocalSocket(url, join(run, 'data/local-rpc.credential')),
});
hub.registerTransport(transport);
let preview: ReturnType<typeof Bun.serve> | undefined;
const coordinator = {
  model: 'coordinator-fixture',
  provider: 'custom:coordinator',
  thinkingLevel: 'off',
};
const front = { model: 'front-fixture', provider: 'custom:front', thinkingLevel: 'off' };
const observed: Record<string, unknown> = { head: process.argv[2], passed: false };
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.jobProcessor.stop();
  await transport.connect();
  setModelsCache(
    new Map([
      [
        'global',
        [coordinator, front].map(
          (entry) =>
            ({
              id: entry.model,
              name: entry.model,
              provider: entry.provider,
              available: true,
              thinkingModes: 'none',
            }) as ModelInfo
        ),
      ],
    ])
  );
  const invoke = <T>(name: string, input: unknown) =>
    hub.request<T>('operation.invoke', { name, input });
  assert.equal((await invoke<{ ok: boolean }>('neo.preferences.set', coordinator)).ok, true);
  assert.notEqual(app.db.getGlobalSettings().neo?.front?.enabled, true);
  assert.equal(
    (
      await invoke<{ ok: boolean }>('neo.front.model.set', {
        ...front,
        provider: coordinator.provider,
      })
    ).ok,
    false
  );
  const selected = await invoke<{ ok: boolean; preferences: typeof front }>(
    'neo.front.model.set',
    front
  );
  assert.deepEqual(selected, { ok: true, preferences: front });
  assert.deepEqual(app.db.getGlobalSettings().neo?.preferences, coordinator);
  await hub.request('settings.global.update', {
    updates: { neo: { front: { enabled: true, model: coordinator } } },
  });
  assert.deepEqual(app.db.getGlobalSettings().neo?.front, { model: front });
  observed.rpc = { selected, wrongProviderRejected: true, stalePatchProtected: true };
  if (process.env.VERIFY_BROWSER) {
    const dist = resolve('packages/web/dist');
    assert(existsSync(join(dist, 'neo/index.html')));
    preview = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, server) {
        const refusal = await app.guardRequest(request);
        if (refusal) return refusal;
        const path = new URL(request.url).pathname;
        if (path === '/ws') {
          const device = await app.authenticateUpgrade(request, '127.0.0.1');
          if (!device) return new Response('Unauthorized', { status: 401 });
          if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
          return new Response('Upgrade failed', { status: 500 });
        }
        const file = Bun.file(
          join(
            dist,
            path === '/settings' ? 'index.html' : path === '/neo' ? 'neo/index.html' : path
          )
        );
        return (await file.exists())
          ? new Response(file)
          : new Response('Not found', { status: 404 });
      },
      websocket: createWebSocketHandlers(app.transport, app.sessionManager),
    });
    assert(![8399, 8499].includes(preview.port));
    const pair = await invoke<{ ok: boolean; code: string }>('device.pair.create', {
      kind: 'human',
      name: 'Synthetic front model browser',
    });
    assert(pair.ok);
    const fixture = join(run, 'browser-fixture.json');
    writeFileSync(
      fixture,
      JSON.stringify({
        url: `http://127.0.0.1:${preview.port}/settings?tab=neo-model`,
        pairBase: `http://127.0.0.1:${app.server.port}`,
        pairCode: pair.code,
        evidence: join(run, 'evidence'),
      })
    );
    const child = Bun.spawn(['node', '.claude/skills/verify/neo-front-model-web.mjs', fixture], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    assert.equal(await child.exited, 0);
    observed.browser = true;
  }
  assert.notEqual(app.db.getGlobalSettings().neo?.front?.enabled, true);
  assert.deepEqual(app.db.getGlobalSettings().neo?.preferences, coordinator);
  observed.switchOff = true;
  observed.passed = true;
} finally {
  preview?.stop(true);
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
}
console.log(JSON.stringify(observed));
