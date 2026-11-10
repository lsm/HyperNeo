import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionConfig } from '@hyperneo/shared';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['bin', 'workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.chdir(run);
const config = {
  ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  disableWorktrees: true,
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const observed: unknown[] = [];
async function boot() {
  app = await createDaemonApp({ config, verbose: false });
  assert(app.server.port > 0 && app.server.port !== 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, {
    headers: { authorization: `Bearer ${await readLocalCredential()}` },
  } as unknown as string[]);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('isolated connection failed'));
  });
  observed.push({ booted: true, port: app.server.port });
}
function rpc(method: string, data: unknown): Promise<unknown> {
  return new Promise((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws!.removeEventListener('message', receive);
      fail(new Error(`${method} timeout`));
    }, 20000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      ws!.removeEventListener('message', receive);
      observed.push({ method, data, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data);
    };
    ws!.addEventListener('message', receive);
    ws!.send(
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
}
let passed = false;
try {
  await boot();
  await rpc('providers.create', {
    params: {
      providerId: 'acp',
      displayName: 'Old stored provider',
      kind: 'built_in',
      authType: 'none',
      isEnabled: true,
    },
  });
  const created = (await rpc('session.create', {
    title: 'Old stored session',
    workspacePath: join(run, 'workspace'),
    worktreeMode: 'direct',
  })) as { sessionId: string };
  await app!.db.updateSession(created.sessionId, {
    config: { provider: 'acp', model: 'acp-default' } as unknown as SessionConfig,
  });
  ws!.close();
  await app!.cleanup();
  app = undefined;
  await boot();
  const providers = (await rpc('providers.list', {})) as {
    providers: { providerId: string; available: boolean }[];
  };
  assert.equal(providers.providers.find((p) => p.providerId === 'acp')?.available, false);
  await rpc('message.send', {
    sessionId: created.sessionId,
    content: 'Synthetic saved-provider check',
  });
  const deadline = Date.now() + 20000;
  let rows: { status: string; retry_count: number; error: string }[] = [];
  do {
    rows = app!.db
      .getDatabase()
      .query(
        "SELECT status, retry_count, error FROM job_queue WHERE queue = 'message_delivery' AND json_extract(payload, '$.sessionId') = ?"
      )
      .all(created.sessionId) as typeof rows;
    if (rows.some((row) => row.status === 'dead')) break;
    await new Promise((done) => setTimeout(done, 50));
  } while (Date.now() < deadline);
  observed.push({
    deliveryRows: rows,
    processingState: app!.db.getSession(created.sessionId)?.processingState,
    messages: app!.db.getSDKMessages(created.sessionId).messages,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'dead');
  assert.equal(rows[0].retry_count, 0);
  assert(rows[0].error.includes('ACP session providers have been retired'), rows[0].error);
  assert.equal(app!.db.getSession(created.sessionId)?.config.provider, 'acp');
  assert(
    JSON.stringify(app!.db.getSDKMessages(created.sessionId).messages).includes(
      'ACP session providers have been retired. Choose another provider for this session.'
    )
  );
  const messages = app!.db
    .getDatabase()
    .query("SELECT send_status FROM sdk_messages WHERE session_id = ? AND message_type = 'user'")
    .all(created.sessionId) as { send_status: string }[];
  assert.deepEqual(
    messages.map((m) => m.send_status),
    ['failed']
  );
  await rpc('providers.list', {});
  observed.push({ rows, messages, daemonResponsiveAfterFailure: true });
  passed = true;
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(
    join(run, 'evidence/provider-removal.json'),
    JSON.stringify({ passed, resourcesStopped: true, observed }, null, 2)
  );
}
console.log(
  'PASS stored provider is unavailable; saved session fails once; daemon remains responsive'
);
