import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

export async function verifySyntheticUnownedPrs(port: number, runText: string) {
  const run = resolve(runText);
  assert(port > 0 && port !== 8399);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.HOME, join(run, 'home'));
  assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
  assert.equal(process.env.HYPERNEO_USE_DEV_PROXY, '1');
  const path = join(run, 'data/daemon.db');
  assert(!existsSync(path), 'requires a fresh synthetic database');
  for (const part of ['data', 'home', 'workspace']) mkdirSync(join(run, part), { recursive: true });
  const api = await createMockApiServer({ port: 8000 });
  await api.start();
  const app = await createDaemonApp({
    config: getConfig({ port, host: '127.0.0.1', dbPath: path }),
    verbose: false,
  });
  const neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const db = app.db.getDatabase();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  let last = performance.now();
  let maxLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  const calls: Record<string, unknown>[] = [];
  const request = <T = Record<string, unknown>>(method: string, data: unknown) =>
    new Promise<T>((done, fail) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => fail(new Error(`${method} timed out`)), 60_000);
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data.toString());
        if (message.requestId !== id) return;
        clearTimeout(timeout);
        if (message.error) fail(new Error(JSON.stringify(message.error)));
        else done(message.data as T);
      };
      ws.send(
        JSON.stringify({
          id,
          type: 'REQ',
          method,
          data,
          sessionId: 'global',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
        })
      );
    });
  const operation = <T = Record<string, unknown>>(name: string, input: unknown) =>
    request<T>('operation.invoke', { name, input });
  const notices: { key: string; text: string }[] = [];
  const activatedAt = (
    db.prepare('SELECT activated_at FROM pack_coding_pr_unowned_state').get() as {
      activated_at: number;
    }
  ).activated_at;
  const node = (number: number, more: Record<string, unknown> = {}) => ({
    number,
    title: `Synthetic PR ${number}`,
    headRefName: `b${number}`,
    headRefOid: `h${number}`,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    closedAt: null,
    createdAt: new Date(activatedAt + 1).toISOString(),
    author: { login: 'synthetic', __typename: 'User' },
    ...more,
  });
  let nodes: unknown[] = [
    ...Array.from({ length: 90 }, (_, i) => node(i + 1)),
    node(91, { isDraft: true }),
    node(92, { author: { login: 'synthetic-bot', __typename: 'Bot' } }),
    node(93, { createdAt: new Date(activatedAt - 1).toISOString() }),
    node(94),
    node(95, { state: 'CLOSED', closedAt: new Date().toISOString() }),
    node(96, { createdAt: null }),
    node(97, { author: null }),
    node(98, { createdAt: new Date(activatedAt).toISOString() }),
  ];
  const ledger = new CodingPrLedgerRepository(db);
  ledger.observeSessions(
    [
      {
        ref: { adapter: 'codex-desktop', id: 'synthetic-owner' },
        status: 'running',
        lastActivityAt: Date.now(),
        remotes: [],
        branches: [],
        openedPrs: [],
        linkedPrs: [{ url: 'https://github.com/synthetic/unowned/pull/94', own: true }],
      },
    ],
    Date.now()
  );
  let accept = true;
  const makePack = () =>
    createCodingPack({
      database: () => db,
      readPrs: async () => [],
      readClaudeOwners: async () => [],
      todoPrs: new CodingTodoPrRepository(db),
      prLedger: ledger,
      prEvents: new CodingPrEventRepository(db),
      prSweep: new CodingPrSweepRepository(db),
      projectRepos: () => ['synthetic/unowned'],
      readLedgerRepo: async () => ({
        data: {
          rateLimit: { remaining: 4000 },
          repository: {
            nameWithOwner: 'synthetic/unowned',
            open: { pageInfo: { hasNextPage: false }, nodes },
            done: { nodes: [] },
          },
        },
      }),
      prSweepDeps: {
        tell: async () => true,
        wake: async (key, text) => {
          notices.push({ key, text });
          const handed = await neo.wakeNeo(key, text);
          return accept && handed;
        },
      },
    });
  let pack = makePack();
  app.messageHub.onRequest('verify.unowned.reconcile', async () => {
    await pack.sweep!(Date.now());
    return { reconciled: true };
  });
  const reconcile = async (name: string) => {
    await pause(30);
    maxLagMs = 0;
    last = performance.now();
    const start = performance.now();
    await request('verify.unowned.reconcile', {});
    const elapsedMs = performance.now() - start;
    await pause(30);
    calls.push({ name, elapsedMs, maxLagMs, wakeAttempts: notices.length });
    writeFileSync(
      join(run, 'observed.json'),
      JSON.stringify(
        {
          surface:
            'isolated daemon RPC -> real coding-pack reconcile -> ReturnType<typeof createNeoService>.wakeNeo -> real mailbox',
          syntheticGitHub: true,
          notices,
          calls,
        },
        null,
        2
      )
    );
    assert(maxLagMs < 1000, `reconcile lag ${maxLagMs}ms exceeds1s goal`);
  };
  try {
    await new Promise<void>((done, fail) => {
      ws.onopen = () => done();
      ws.onerror = () => fail(new Error('connect failed'));
    });
    await request('providers.create', {
      params: {
        providerId: 'anthropic',
        displayName: 'Anthropic (dev proxy)',
        kind: 'built_in',
        authType: 'api_key',
        isEnabled: true,
        isDefault: true,
        sortOrder: 0,
      },
      credentials: { apiKey: 'sk-devproxy-test-key' },
    });
    const opened = await operation<{ ok: boolean; sessionId: string }>('neo.open', {});
    assert(opened.ok && opened.sessionId, JSON.stringify(opened));
    await reconcile('first-90-unowned');
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0].text.split('\n').filter((line) => line.startsWith('synthetic/')).length,
      90
    );
    for (let n = 91; n <= 98; n++) assert(!notices[0].text.includes(`synthetic/unowned#${n} `));
    await reconcile('unchanged');
    assert.equal(notices.length, 1);
    nodes = [...nodes, node(99)];
    accept = false;
    await reconcile('lost-acknowledgement');
    assert.equal(notices.length, 2);
    pack = makePack();
    accept = true;
    await reconcile('restart-retry');
    assert.deepEqual(notices[2], notices[1]);
    await reconcile('after-ack');
    assert.equal(notices.length, 3);
    const delivered: Record<string, unknown>[] = [];
    for (const notice of [notices[0], notices[2]]) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const found = await request<{ messages: { uuid: string; text: string }[] }>(
          'session.messages.byStatus',
          { sessionId: opened.sessionId, status: 'consumed', limit: 1000 }
        );
        const matches = found.messages.filter((item: { uuid: string }) => item.uuid === notice.key);
        if (matches.length) {
          assert.equal(matches.length, 1);
          assert(matches[0].text.includes(notice.text));
          delivered.push(matches[0]);
          break;
        }
        await pause(500);
      }
    }
    writeFileSync(join(run, 'delivered.json'), JSON.stringify(delivered, null, 2));
    assert.equal(
      delivered.length,
      2,
      'both wake batches must reach Neo as consumed input via the real mailbox'
    );
    writeFileSync(
      join(run, 'accepted.json'),
      JSON.stringify({ neoSessionId: opened.sessionId, deliveredBatches: 2, calls }, null, 2)
    );
    process.stdout.write(JSON.stringify({ deliveredBatches: 2, calls }) + '\n');
  } finally {
    clearInterval(timer);
    ws.close();
    await neo.dispose();
    await app.cleanup();
    await api.stop();
    api.restoreEnv();
  }
}
