import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';

const run = resolve(process.argv[2] ?? '');
assert(process.argv[2] && process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')), 'fresh synthetic database required');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'home'), { recursive: true });
const app = await createDaemonApp({
  config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
let ws: WebSocket | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const db = app.db.getDatabase();
  const conversationId = crypto.randomUUID();
  const session = `neo:${conversationId}`;
  const date = new Date().toISOString();
  db.prepare('INSERT INTO neo_conversation(singleton,id,created_at) VALUES(1,?,?)').run(
    conversationId,
    Date.now()
  );
  db.prepare(`INSERT INTO sessions(id,title,created_at,last_active_at,status,config,metadata)
    VALUES(?,?,?,?,?,?,?)`).run(session, 'Synthetic', date, date, 'active', '{}', '{}');
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
  const insert = db.prepare(`INSERT INTO sdk_messages
    (id,session_id,message_type,sdk_message,timestamp,sdk_uuid,send_status) VALUES(?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let i = 0; i < ids.length; i++)
      insert.run(
        `m${i}`,
        session,
        'user',
        JSON.stringify({
          type: 'user',
          uuid: ids[i],
          session_id: session,
          message: { role: 'user', content: 'synthetic retained body '.repeat(90_000) },
        }),
        date,
        ids[i],
        'consumed'
      );
    insert.run(
      'earliest',
      session,
      'user',
      JSON.stringify({
        type: 'user',
        uuid: ids[0],
        session_id: session,
        message: { role: 'user', content: 'Earlier duplicate UUID' },
      }),
      new Date(Date.now() - 60_000).toISOString(),
      ids[0],
      'failed'
    );
  })();
  const ledger = new NeoConversationAskRepository(db);
  for (const [i, requestId] of ids.entries())
    ledger.append({
      conversationId,
      requestId,
      askOrigin: { sessionId: session, messageId: requestId },
      content: `Synthetic ${i}`,
    });
  const hash = () => {
    const sha = createHash('sha256');
    for (const row of db
      .prepare('SELECT id,sdk_message,sdk_uuid,send_status FROM sdk_messages ORDER BY id')
      .iterate())
      sha.update(JSON.stringify(row));
    return sha.digest('hex');
  };
  const beforeHash = hash();
  const stored = db
    .prepare('SELECT COUNT(*) AS rows,SUM(length(sdk_message)) AS bytes FROM sdk_messages')
    .get();
  assert(app.server.port !== 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise((done, fail) => {
    ws!.onopen = done;
    ws!.onerror = fail;
  });
  const samples: number[] = [];
  let maxLagMs = 0;
  let previous = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - previous - 5);
    previous = now;
  }, 5);
  for (let i = 0; i < 3; i++) {
    await new Promise((done) => setTimeout(done, 10));
    const id = crypto.randomUUID();
    const started = performance.now();
    const response = await new Promise<{
      ok: boolean;
      items: { requestId: string; messageStatus: string }[];
    }>((done, fail) => {
      const timeout = setTimeout(() => fail(new Error('RPC timeout')), 10_000);
      ws!.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.requestId !== id) return;
        clearTimeout(timeout);
        done(message.data);
      };
      ws!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          method: 'operation.invoke',
          data: { name: 'neo.conversation.asks.read', input: { conversationId, limit: 100 } },
          sessionId: 'global',
          version: '1.0.0',
          timestamp: date,
        })
      );
    });
    samples.push(performance.now() - started);
    assert.equal(response.ok, true);
    assert.deepEqual(
      response.items.map((item) => [item.requestId, item.messageStatus]),
      ids.map((requestId, at) => [requestId, at === 0 ? 'failed' : 'read'])
    );
  }
  await new Promise((done) => setTimeout(done, 10));
  clearInterval(timer);
  const afterHash = hash();
  const observed = {
    surface: 'production neo.conversation.asks.read over isolated WebSocket',
    syntheticOnly: true,
    runtime: process.versions.bun,
    stored,
    samplesMs: samples,
    maxLagMs,
    beforeHash,
    afterHash,
    earliestDuplicatePreserved: true,
  };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(observed, null, 2));
  process.stdout.write(`${JSON.stringify(observed)}\n`);
  assert.equal(afterHash, beforeHash);
  assert(Math.max(...samples) <= 250, '100-ask status page must complete within 250ms');
  assert(maxLagMs < 1000, 'status page must not block the event loop for one second');
} finally {
  clearInterval(timer);
  ws?.close();
  await app.cleanup();
}
