import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../packages/daemon/src/storage/sqlite-compat.ts';
import { createLocalSocket } from '../packages/daemon/src/lib/pairing/local-credential.ts';
import { SPACE_SCHEMA } from '../packages/daemon/src/storage/schema/space-schema.ts';
import { MessageHub, WebSocketClientTransport } from '../packages/shared/src/mod.ts';

const run = resolve(process.argv[2] ?? '');
const spaceOff = process.env.HYPERNEO_SPACE !== 'on';
async function waitForMailboxJob(dbPath: string, sessionId: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const read = () =>
      db
        .prepare(
          `SELECT status, error FROM job_queue
            WHERE queue = 'mailbox' AND json_extract(payload, '$.to.sessionId') = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(sessionId) as { status: string; error: string | null } | undefined;
    for (let attempt = 0; attempt < 100 && read()?.status !== 'completed'; attempt++)
      await new Promise((done) => setTimeout(done, 50));
    return read();
  } finally {
    db.close();
  }
}

const SESSION_EVENT_OPERATIONS = [
  'event.external.subscribe',
  'event.external.unsubscribe',
  'event.external.subscription.list',
  'event.external.get',
  'event.external.delivery.list',
];
const tableNames = (db: Database) =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
const spaceTableNames = () => {
  const db = new Database(':memory:');
  try {
    for (const statement of SPACE_SCHEMA.baseline?.statements ?? []) db.exec(statement);
    SPACE_SCHEMA.tables?.(db);
    return new Set(tableNames(db));
  } finally {
    db.close();
  }
};
assert(process.versions.bun, 'Use Bun for this probe');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')), 'Probe requires fresh owned data');
for (const key of [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
])
  assert.equal(process.env[key], undefined);
for (const name of ['home', 'tmp', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('../packages/daemon/main.ts', import.meta.url))],
  {
    env: {
      HOME: join(run, 'home'),
      TMPDIR: join(run, 'tmp'),
      PATH: join(run, 'bin') + ':/usr/bin:/bin',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      HYPERNEO_PORT: '0',
      DB_PATH: join(run, 'data/daemon.db'),
      HYPERNEO_DATA_DIR: join(run, 'data'),
      HYPERNEO_WORKSPACE_PATH: join(run, 'workspace'),
      LOG_LEVEL: 'warn',
      ...(spaceOff ? {} : { HYPERNEO_SPACE: 'on' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let log = '',
  childExited = false,
  interrupted = 0;
const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
  child.once('close', (code, signal) => {
    childExited = true;
    done({ code, signal });
  });
});
child.stdout.on('data', (data) => {
  log += data.toString();
});
child.stderr.on('data', (data) => {
  log += data.toString();
});
child.on('error', (error) => {
  log += String(error);
});
const onInt = () => {
  interrupted = 130;
  child.kill('SIGTERM');
};
const onTerm = () => {
  interrupted = 143;
  child.kill('SIGTERM');
};
process.once('SIGINT', onInt);
process.once('SIGTERM', onTerm);
const until = async (ready: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ready()) {
    assert(Date.now() < end, 'Timed out waiting for owned Bun daemon');
    await new Promise((done) => setTimeout(done, 20));
  }
};
let transport: WebSocketClientTransport | undefined;
let unsubscribe: (() => void) | undefined;
const evidence: Record<string, unknown> = { runtime: 'bun', pid: child.pid };
try {
  await until(() => /\bPort:\s*(\d+)/.test(log) || childExited, 30000);
  assert(!childExited, 'Daemon exited during startup: ' + log.slice(-1000));
  const port = Number(/\bPort:\s*(\d+)/.exec(log)?.[1]);
  assert(port > 0 && port !== 8399);
  evidence.port = port;
  const url = 'http://127.0.0.1:' + port;
  const http = await fetch(url + '/', { signal: AbortSignal.timeout(5000) });
  assert.equal(http.status, 200);
  evidence.httpStatus = http.status;
  const hub = new MessageHub({ defaultSessionId: 'global', timeout: 5000 });
  transport = new WebSocketClientTransport({
    url: url.replace('http:', 'ws:') + '/ws',
    autoReconnect: false,
    createSocket: (address) => createLocalSocket(address, join(run, 'data/local-rpc.credential')),
  });
  hub.registerTransport(transport);
  await transport.initialize();
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  evidence.health = 'ok';
  if (spaceOff) {
    const listed = await hub.request<{ name: string }[]>('operation.invoke', {
      name: 'operations.list',
      input: { all: true, query: 'event.external' },
    });
    const names = listed.map((operation) => operation.name);
    for (const name of SESSION_EVENT_OPERATIONS) assert(names.includes(name), `${name} is missing`);
    evidence.sessionEventOperations = SESSION_EVENT_OPERATIONS;
  }
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'),
    config: { queryMode: 'manual' },
  });
  const created = await hub.request<{ accepted: boolean; goal?: { id: string } }>(
    'operation.invoke',
    {
      name: 'goal.session.create',
      input: {
        ownerSessionId: sessionId,
        title: 'Boot probe goal',
        doneTest: 'Listed after create',
        cadence: { kind: 'every', everyMs: 900000 },
      },
    }
  );
  assert.equal(created.accepted, true);
  const listed = await hub.request<{ goals: { id: string }[] }>('operation.invoke', {
    name: 'goal.session.list',
    input: { ownerSessionId: sessionId },
  });
  assert.deepEqual(
    listed.goals.map((goal) => goal.id),
    [created.goal?.id]
  );
  evidence.goalListed = true;
  const status = await hub.request<{ total: number; messages: unknown[] }>(
    'session.messages.byStatus',
    {
      sessionId,
      status: 'consumed',
      limit: 20,
    }
  );
  assert.equal(status.total, 0);
  assert.deepEqual(status.messages, []);
  evidence.statusEmpty = true;
  const page = await hub.request<{ sdkMessages: unknown[]; backgroundTaskMessages: unknown[] }>(
    'message.sdkMessages',
    { sessionId, limit: 20 }
  );
  assert.deepEqual(page.sdkMessages, []);
  assert.deepEqual(page.backgroundTaskMessages, []);
  evidence.pageEmpty = true;
  let rows: unknown[] | undefined;
  unsubscribe = hub.onEvent<{ subscriptionId: string; rows: unknown[] }>(
    'liveQuery.snapshot',
    (event) => {
      if (event.subscriptionId === 'bun-boot-live') rows = event.rows;
    }
  );
  const live = await hub.request<{ ok: boolean }>('liveQuery.subscribe', {
    queryName: 'messages.bySession',
    subscriptionId: 'bun-boot-live',
    params: [sessionId, 20],
  });
  assert.equal(live.ok, true);
  assert.notEqual(rows, undefined, 'Snapshot must precede subscribe acknowledgement');
  evidence.snapshotBeforeAck = true;
  assert.deepEqual(rows, []);
  evidence.liveEmpty = true;
  if (spaceOff) {
    await hub.request('operation.invoke', {
      name: 'message.send',
      input: { to: sessionId, text: 'Space-off mailbox probe', from: 'session:boot-probe' },
    });
    evidence.mailbox = await waitForMailboxJob(join(run, 'data/daemon.db'), sessionId);
    assert.deepEqual(evidence.mailbox, { status: 'completed', error: null });
  }
  const db = new Database(join(run, 'data/daemon.db'), { readonly: true });
  try {
    const tables = Number(
      db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE type = ?').get('table')?.n
    );
    assert(tables > 80);
    evidence.tables = tables;
    if (spaceOff) {
      const space = spaceTableNames();
      assert(space.size > 50, 'Space table list is too small to prove absence');
      assert.deepEqual(
        tableNames(db).filter((name) => space.has(name)),
        []
      );
      evidence.spaceTables = 0;
    }
  } finally {
    db.close();
  }
  if (spaceOff) {
    assert.doesNotMatch(log, /no such table/);
    evidence.noMissingTables = true;
  }
  await transport.close();
  transport = undefined;
  assert(child.kill('SIGTERM'));
  await until(() => childExited, 10000);
  const result = await exited;
  evidence.shutdownCode = result.code;
  evidence.shutdownSignal = result.signal;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(log, /Received SIGTERM, shutting down gracefully/);
  assert.match(log, /Graceful shutdown complete/);
  evidence.gracefulShutdown = true;
  assert.equal(interrupted, 0);
  evidence.pass = true;
} catch (error) {
  evidence.error = String(error);
  console.error(error);
  process.exitCode = interrupted || 1;
} finally {
  unsubscribe?.();
  try {
    await transport?.close();
  } finally {
    if (!childExited) child.kill('SIGKILL');
    await until(() => childExited, 10000);
    await exited;
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    evidence.childExited = childExited;
    writeFileSync(join(run, 'evidence/daemon.log'), log);
    writeFileSync(join(run, 'evidence/bun-daemon-boot.json'), JSON.stringify(evidence, null, 2));
  }
}
