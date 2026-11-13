import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
const credential = 'synthetic-kimi-loopback-key';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.KIMI_API_KEY, undefined);
assert.equal(process.env.MOONSHOT_API_KEY, undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });

const requests: { path: string; authorizationMatched: boolean }[] = [];
const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    requests.push({
      path: url.pathname,
      authorizationMatched: request.headers.get('authorization') === `Bearer ${credential}`,
    });
    return Response.json({
      usage: {
        name: '5-hour usage',
        used: 12,
        limit: 100,
        reset_at: '2026-11-12T20:00:00Z',
      },
      limits: [
        {
          window: { duration: 7, timeUnit: 'DAYS' },
          detail: { remaining: 40, limit: 200, resetTime: 1_760_000_000 },
        },
        { name: 'Incomplete', used: 3 },
      ],
    });
  },
});
process.env.KIMI_BASE_URL = `http://127.0.0.1:${fixture.port}/coding/v1`;

let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }),
      disableWorktrees: true,
    },
    standalone: true,
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    socket!.onopen = () => done();
    socket!.onerror = () => fail(new Error('RPC connection failed'));
  });
  const call = <T>(method: string, data: unknown): Promise<T> =>
    new Promise<T>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 10_000);
      const onMessage = (event: MessageEvent) => {
        const reply = JSON.parse(String(event.data));
        if (reply.requestId !== id && reply.id !== id) return;
        clearTimeout(timer);
        socket!.removeEventListener('message', onMessage);
        if (reply.error) fail(new Error(JSON.stringify(reply.error)));
        else done(reply.data as T);
      };
      socket!.addEventListener('message', onMessage);
      socket!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method,
          data,
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });

  await call('providers.create', {
    params: {
      providerId: 'kimi',
      displayName: 'Synthetic Kimi Coding',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: false,
      sortOrder: 0,
    },
    credentials: { apiKey: credential },
  });
  const result = await call('operation.invoke', {
    name: 'settings.provider.usage',
    input: { providerId: 'kimi' },
  });
  const expected = {
    supported: true,
    provider: 'kimi',
    windows: [
      {
        label: '5-hour usage',
        used: 12,
        limit: 100,
        resetAt: '2026-11-12T20:00:00.000Z',
      },
      {
        label: '7d limit',
        used: 160,
        limit: 200,
        resetAt: new Date(1_760_000_000_000).toISOString(),
      },
    ],
  };
  assert.deepEqual(result, expected);
  assert(!JSON.stringify(result).includes(credential));
  assert.deepEqual(requests, [
    { path: '/coding/v1/usages', authorizationMatched: true },
  ]);
  const unsupported = await call('operation.invoke', {
    name: 'settings.provider.usage',
    input: { providerId: 'missing' },
  });
  assert.deepEqual(unsupported, {
    supported: false,
    provider: 'missing',
    reason: 'not_supported',
  });
  writeFileSync(
    join(run, 'evidence/provider-usage.json'),
    JSON.stringify({ result, requests, unsupported }, null, 2)
  );
  console.log(JSON.stringify({ passed: true, windows: expected.windows.length, requests: 1 }));
} finally {
  socket?.close();
  await app?.cleanup();
  await fixture.stop(true);
  writeFileSync(
    join(run, 'evidence/cleanup.json'),
    JSON.stringify({ daemonStopped: true, fixtureStopped: true })
  );
}
