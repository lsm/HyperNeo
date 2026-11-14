import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });

const resetsSevenDay = 1_795_006_800;
const storedEvents = [
  {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.87,
      resetsAt: 1_795_000_000,
    },
  },
  {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: resetsSevenDay },
  },
];

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
  const sessionId = 'synthetic-usage-session';
  await app.db.createSession({
    id: sessionId,
    title: 'Synthetic usage session',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  const db = app.db.getDatabase();
  const insert = db.prepare(
    `INSERT INTO sdk_messages(id, session_id, message_type, timestamp, sdk_message)
     VALUES (?, ?, 'rate_limit_event', ?, ?)`
  );
  storedEvents.forEach((event, index) =>
    insert.run(
      crypto.randomUUID(),
      sessionId,
      new Date(Date.UTC(2026, 10, 13, 10 + index)).toISOString(),
      JSON.stringify(event)
    )
  );
  await app.jobProcessor.stop();
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    socket!.onopen = () => done();
    socket!.onerror = () => fail(new Error('RPC connection failed'));
  });
  const call = <T>(method: string, data: unknown): Promise<T> =>
    new Promise<T>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 60_000);
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
      providerId: 'anthropic',
      displayName: 'Synthetic Claude subscription',
      kind: 'built_in',
      authType: 'oauth',
      isEnabled: true,
      isDefault: false,
      sortOrder: 0,
    },
    credentials: {
      oauthAccessToken: 'synthetic-subscription-token',
      oauthRefreshToken: 'synthetic-refresh-token',
      oauthExpiresAt: Date.now() + 3_600_000,
    },
  });
  const usage = await call('operation.invoke', {
    name: 'settings.provider.usage',
    input: { providerId: 'anthropic' },
  });

  assert.deepEqual(usage, {
    supported: true,
    provider: 'anthropic',
    windows: [
      {
        label: '5 hours',
        used: 87,
        limit: 100,
        resetAt: new Date(1_795_000_000_000).toISOString(),
      },
      {
        label: '7 days',
        used: 100,
        limit: 100,
        resetAt: new Date(resetsSevenDay * 1000).toISOString(),
      },
    ],
  });
  assert(!JSON.stringify(usage).includes('synthetic-subscription-token'));
  writeFileSync(
    join(run, 'evidence/anthropic-usage.json'),
    JSON.stringify({ usage, storedEvents: storedEvents.length }, null, 2)
  );
  console.log(
    JSON.stringify({ passed: true, windows: usage.windows.length, source: 'stored_events' })
  );
} finally {
  socket?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ daemonStopped: true }));
}
