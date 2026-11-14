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
const config = { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true };
const app = await createDaemonApp({ config, standalone: false, verbose: false });
let ws: WebSocket | undefined;
const evidence: Record<string, unknown> = {};
try {
  await app.jobProcessor.stop();
  assert.equal(config.port, 0);
  assert.equal(config.disableWorktrees, true);
  assert.notEqual(app.server.port, 8399);
  evidence.isolation = { requestedPort: config.port, actualPort: app.server.port, disableWorktrees: config.disableWorktrees };
  const conversationId = '20000000-0000-4000-8000-000000000001';
  const root = `neo:${conversationId}`;
  await app.db.createSession({ id: root, title: 'Synthetic Neo', workspacePath: run, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model: 'synthetic' }, metadata: {} } as never);
  const repo = new NeoRepository(app.db.getDatabase());
  repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    const invoke = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const publish = async (requestId: string, text: string, details?: string) =>
    JSON.parse((await invoke({ name: 'neo.publication.publish', input: { requestId, text, ...(details ? { details } : {}) } })).content[0].text);
  const credential = readLocalCredential(join(run, 'data/local-rpc.credential'));
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, { headers: { authorization: `Bearer ${credential}` } } as unknown as string[]);
  await new Promise((resolve, reject) => { ws!.onopen = resolve; ws!.onerror = reject; });
  const read = () => new Promise<{ ok: boolean; items: { shortText?: string; fullText: string }[] }>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error('Publication reader timed out')), 10000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if ((reply.requestId ?? reply.id) !== id) return;
      clearTimeout(timer);
      if (reply.error) reject(new Error(JSON.stringify(reply.error)));
      else resolve(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'neo.publication.read', input: { conversationId } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const long = Array(61).fill('word').join(' ');
  evidence.longAlone = await publish('long-alone', long);
  evidence.list = await publish('list', '**Status**\n- one\n- two\n- three\n- four\n- five');
  evidence.chinese = await publish('chinese', '中'.repeat(151));
  evidence.base64 = await publish('base64', `Key: ${'QUJD'.repeat(125)}`);
  evidence.longSummary = await publish('long-summary', long, `${long} ${long}`);
  for (const key of ['longAlone', 'list', 'chinese', 'base64']) {
    assert.equal((evidence[key] as { accepted: boolean }).accepted, false);
    assert.match((evidence[key] as { reason: string }).reason, /^reply_needs_details: .*the rest in details/);
  }
  assert.match((evidence.longSummary as { reason: string }).reason, /^reply_summary_too_long: .*shrink text/);
  const before = await read();
  evidence.before = before;
  assert.equal(before.items.length, 0);
  evidence.split = await publish('split', 'Merged and CI is green.', long);
  evidence.short = await publish('short', '**Merged**\n- CI green\n- 已部署');
  assert.equal((evidence.split as { accepted: boolean }).accepted, true);
  assert.equal((evidence.short as { accepted: boolean }).accepted, true);
  const after = await read();
  evidence.after = after;
  assert.equal(after.items.length, 2);
  assert.deepEqual(after.items.map((item) => [item.shortText, item.fullText]), [
    ['Merged and CI is green.', long],
    [undefined, '**Merged**\n- CI green\n- 已部署'],
  ]);
  evidence.passed = true;
} finally {
  ws?.close();
  await app.cleanup();
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
