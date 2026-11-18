import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = process.argv[2];
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await mkdir(join(run, 'evidence'), { recursive: true });
await writeFile(join(run, 'bin/gh'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
const config = {
  ...getConfig({
    port: 0,
    host: '127.0.0.1',
    dbPath: join(run, 'data/daemon.db'),
    workspaceRoot: run,
  }),
  disableWorktrees: true,
};
const app = await createDaemonApp({ config, standalone: false, verbose: false });
let ws: WebSocket | undefined;
const evidence: Record<string, unknown> = {};
try {
  await app.jobProcessor.stop();
  assert.equal(config.port, 0);
  assert.equal(config.disableWorktrees, true);
  assert.notEqual(app.server.port, 8399);
  evidence.isolation = {
    requestedPort: config.port,
    actualPort: app.server.port,
    disableWorktrees: config.disableWorktrees,
  };
  const conversationId = '20000000-0000-4000-8000-000000000001';
  app.db.getDatabase().prepare('INSERT OR REPLACE INTO neo_conversation (singleton, id, created_at) VALUES (1, ?, 0)').run(conversationId);
  const root = `neo:${conversationId}`;
  const now = new Date().toISOString();
  await app.db.createSession({
    id: root,
    title: 'Synthetic Neo',
    workspacePath: run,
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { model: 'synthetic' },
    metadata: {},
  } as never);
  new NeoRepository(app.db.getDatabase()).reserveBinding({
    sessionId: root,
    kind: 'neo',
    projectId: null,
  });
  const invoke = createOperationMcpHandler(
    () => app.sessionManager.getOperationRegistry(),
    () => ({ sessionId: root, role: 'neo' })
  );
  const publish = async (
    requestId: string,
    text: string,
    details?: string,
    extra: Record<string, unknown> = {}
  ) =>
    JSON.parse(
      (
        await invoke({
          name: 'neo.publication.publish',
          input: { requestId, text, ...(details ? { details } : {}), ...extra },
        })
      ).content[0].text
    );
  const credential = readLocalCredential(join(run, 'data/local-rpc.credential'));
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, {
    headers: { authorization: `Bearer ${credential}` },
  } as unknown as string[]);
  await new Promise((resolve, reject) => {
    ws!.onopen = resolve;
    ws!.onerror = reject;
  });
  const read = (target = conversationId) =>
    new Promise<{ ok: boolean; items: { shortText?: string; fullText: string }[] }>(
      (resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => reject(new Error('Publication reader timed out')), 10000);
        ws!.onmessage = (event) => {
          const reply = JSON.parse(String(event.data));
          if ((reply.requestId ?? reply.id) !== id) return;
          clearTimeout(timer);
          if (reply.error) reject(new Error(JSON.stringify(reply.error)));
          else resolve(reply.data);
        };
        ws!.send(
          JSON.stringify({
            id,
            type: 'REQ',
            sessionId: 'global',
            method: 'operation.invoke',
            data: { name: 'neo.publication.read', input: { conversationId: target } },
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          })
        );
      }
    );
  evidence.missing = await read('20000000-0000-4000-8000-000000000002');
  assert.deepEqual(evidence.missing, { ok: false, reason: 'conversation_not_found' });
  evidence.before = await read();
  evidence.missingSession = await publish('missing-session', 'Update', undefined, { session: 'missing-session' });
  assert.match(JSON.stringify(evidence.missingSession), /unknown_session/);
  evidence.published = await publish('publication-proof', 'A publication');
  assert.equal((evidence.published as { accepted: boolean }).accepted, true);
  evidence.after = await read();
  assert.equal((evidence.after as { items: unknown[] }).items.length, 1);
} finally {
  ws?.close();
  await app.cleanup();
  delete evidence.isolation;
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
